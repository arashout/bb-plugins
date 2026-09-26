// Pure presentation model for the Pipeline. GitHub and checkout facts remain the source of truth.
import type { Pr } from "./contract.js";
import type { Row } from "./inbox-rows.js";
import type { AdvanceBatch, AdvanceJob } from "./bulk-advance.js";
import type { DispatchState } from "./dispatch.js";
import type { PrHold, PrHolds } from "./pr-holds.js";
import { canonicalPrUrl } from "./pr-holds.js";
import { prBacklog, type BacklogEntry, type BacklogRow } from "./pr-backlog.js";
import type { WireRun } from "./server.js";
import { isAdvanceEligible } from "./bulk-advance-selection.js";
import { displayTitle, isTicketlessClone, prLifecycle, type Lifecycle } from "./workstreams.js";
import { checksFailed, checksGreen } from "./pr-checks.js";
import { prWorkItemKey } from "./work-item-index.js";

export const PIPELINE_STAGES = ["build", "review", "feedback", "ready", "merged", "released"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export type PipelineBlocker = { label: string; tone: "bad" | "warn" | "wait" | "clear" };
export type PipelineActivity = { state: "none" | "working" | "done" | "needs-you"; detail: string; threadId: string | null; source: "advance" | "dispatch" | "run" | null };
export type PipelineAction = { kind: "merge" | "advance" | "fix" | "nudge" | "open-parent" | "open-thread" | "open-pr" | "release"; label: string; behind?: number } | null;
export type PipelineCard = {
  key: string; repo: string; title: string; pr: Pr | null; local: Row | null; backlog: BacklogRow | null;
  effortKey: string | null; effortName: string | null; hold: PrHold | null;
  stage: PipelineStage; blocker: PipelineBlocker; activity: PipelineActivity; action: PipelineAction;
  ageSince: number | null; stale: boolean;
};
export type PipelineSources = { holds?: PrHolds; batches?: readonly AdvanceBatch[]; dispatch?: DispatchState; runs?: readonly WireRun[] };

const ACTIVE_JOBS = new Set<AdvanceJob["status"]>(["queued", "launching", "running", "verifying"]);
const NONE: PipelineActivity = { state: "none", detail: "", threadId: null, source: null };
const repoOf = (pr: Pr, fallback: string): string => {
  const canonical = canonicalPrUrl(pr.url);
  return canonical === null ? fallback : new URL(canonical).pathname.split("/").slice(1, 3).join("/");
};

/** Lifecycle owns position. A draft and an active rebase stay in Build even with bad checks. */
export function stageFor(lifecycle: Lifecycle, pr: Pr | null, behind: number | null = null): PipelineStage {
  if (lifecycle === "shipped") return "released";
  if (lifecycle === "merged" || lifecycle === "closed") return "merged";
  if (pr === null || pr.isDraft || lifecycle === "active" || lifecycle === "in-progress" || lifecycle === "up-next") return "build";
  if (checksFailed(pr.checkConclusions)) return "feedback";
  if (pr !== null && !pr.isDraft && (pr.mergeStateStatus === "DIRTY" || pr.mergeStateStatus === "BEHIND")) return "feedback";
  if (behind !== null && pr?.reviewDecision === "APPROVED" && lifecycle === "awaiting-merge") return "ready";
  if (lifecycle === "blocked" || lifecycle === "awaiting-followup" || lifecycle === "approved-with-comments" || lifecycle === "approved-with-note") return "feedback";
  if (lifecycle === "awaiting-merge") return "ready";
  return "review"; // Awaiting review, re-review, or facts that need verification.
}

/** One visible gate, ordered by the repair that must happen first. */
export function blockerFor(pr: Pr | null, stage: PipelineStage, hold: PrHold | null, behind: number | null = null, stale = false): PipelineBlocker {
  if (hold !== null) return { label: "On hold", tone: "wait" };
  if (stage === "merged" || stage === "released") return { label: "Clear", tone: "clear" };
  if (pr === null || stage === "build") return { label: "In progress", tone: "wait" };
  if (stale) return { label: "Status unknown", tone: "wait" };
  if (checksFailed(pr.checkConclusions)) return { label: "CI failing", tone: "bad" };
  if (pr.mergeStateStatus === "DIRTY") return { label: "Conflicts", tone: "bad" };
  if (pr.reviewDecision === "CHANGES_REQUESTED" && !pr.reviewFollowupPosted) return { label: "Changes requested", tone: "warn" };
  if (pr.unresolvedReviewThreads !== null && pr.unresolvedReviewThreads > 0) return { label: `${pr.unresolvedReviewThreads} open threads`, tone: "warn" };
  if (pr.reviewDecision === "APPROVED" && pr.approvalHasBody && !pr.approvalNoteFollowedUp) return { label: "Review note", tone: "warn" };
  if (behind !== null) return { label: `Behind #${behind}`, tone: "wait" };
  if (pr.reviewDecision === "CHANGES_REQUESTED" && pr.reviewFollowupPosted) return { label: "Awaiting re-review", tone: "wait" };
  if (pr.reviewDecision === "APPROVED" && !checksGreen(pr.checkConclusions)) return { label: "Checks pending", tone: "wait" };
  if (pr.mergeStateStatus === "BEHIND") return { label: "Branch behind", tone: "wait" };
  if (pr.mergeStateStatus === "BLOCKED") return { label: "Rules block", tone: "wait" };
  if (pr.mergeStateStatus === "UNKNOWN" || pr.unresolvedReviewThreads === null) return { label: "Status unknown", tone: "wait" };
  if (pr.reviewDecision !== "APPROVED" && pr.reviewRequests.length === 0) return { label: "No reviewer", tone: "wait" };
  if (pr.reviewDecision !== "APPROVED") return { label: "Awaiting review", tone: "wait" };
  return { label: "Clear", tone: "clear" };
}

/** Newest matching activity wins across Advance, automatic dispatch, and row actions. */
export function activityFor(prUrl: string | null, path: string | null, sources: PipelineSources): PipelineActivity {
  const candidates: { at: number; activity: PipelineActivity }[] = [];
  if (prUrl !== null) {
    for (const batch of sources.batches ?? []) for (const job of batch.jobs) {
      if (prWorkItemKey(job.prUrl) !== prWorkItemKey(prUrl) || job.hiddenFromProgress || job.status === "cancelled" || job.status === "merged" || job.status === "closed") continue;
      const state = ACTIVE_JOBS.has(job.status) ? "working" : job.status === "needs-attention" ? "needs-you" : "done";
      candidates.push({ at: job.updatedAt, activity: { state, detail: job.detail, threadId: job.threadId, source: "advance" } });
    }
    for (const attempt of sources.dispatch?.attempts ?? []) {
      if (prWorkItemKey(attempt.prUrl) !== prWorkItemKey(prUrl)) continue;
      const state = ["launching", "running", "verifying"].includes(attempt.status) ? "working" : ["needs-you", "failed"].includes(attempt.status) ? "needs-you" : "done";
      candidates.push({ at: attempt.startedAt, activity: { state, detail: attempt.detail, threadId: attempt.threadId, source: "dispatch" } });
    }
  }
  for (const run of sources.runs ?? []) {
    if (run.kind !== "agent" || (prUrl === null || run.prUrl === null ? run.path !== path : prWorkItemKey(run.prUrl) !== prWorkItemKey(prUrl))) continue;
    const state = run.status === "running" ? "working" : run.status === "needs-you" || run.status === "failed" ? "needs-you" : "done";
    candidates.push({ at: run.finishedAt ?? run.startedAt, activity: { state, detail: run.result ?? run.error ?? run.action, threadId: run.threadId, source: "run" } });
  }
  return candidates.sort((a, b) => Number(b.activity.state === "working") - Number(a.activity.state === "working") || b.at - a.at)[0]?.activity ?? NONE;
}

export function primaryPipelineAction(stage: PipelineStage, blocker: PipelineBlocker, activity: PipelineActivity, hold: PrHold | null, behind: number | null): PipelineAction {
  if (hold !== null) return { kind: "release", label: "Release" };
  if (stage === "merged" || stage === "released") return null;
  if (activity.state === "needs-you") return { kind: "fix", label: "Fix" };
  if (activity.state === "working") return stage === "build" && activity.threadId !== null ? { kind: "open-thread", label: "Open thread" } : null;
  if (stage === "build") return activity.threadId !== null ? { kind: "open-thread", label: "Open thread" } : null;
  if (behind !== null) return { kind: "open-parent", label: "Open parent", behind };
  if (stage === "ready" && blocker.label === "Clear") return { kind: "merge", label: "Merge" };
  if (stage === "feedback" && blocker.label !== "Status unknown") return { kind: "advance", label: "Advance" };
  if (stage === "review" && (blocker.label === "Awaiting review" || blocker.label === "No reviewer")) return { kind: "nudge", label: "Nudge" };
  return null;
}

function ageOf(pr: Pr | null, local: Row | null): number | null {
  const source = pr === null ? local?.unit.lastCommitAt : pr.createdAt;
  const parsed = source ? Date.parse(source) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** One card per PR, with remote inventory facts preferred; checkout-only work also appears. */
export function pipelineCards(entries: readonly BacklogEntry[], locals: readonly Row[], now: number, sources: PipelineSources = {}): PipelineCard[] {
  const backlog = prBacklog(entries, locals, now, sources.holds);
  const covered = new Set(backlog.map((row) => prWorkItemKey(row.pr.url)));
  const cards: PipelineCard[] = [];
  const add = (local: Row | null, remote: BacklogRow | null): void => {
    const pr = remote?.pr ?? local?.unit.pr ?? null;
    const stale = remote?.stale ?? false;
    const lifecycle = stale ? "unverified" : remote?.lifecycle ?? local?.unit.lifecycle ?? (pr === null ? "up-next" : prLifecycle(pr));
    const behind = remote?.parent?.pr.number ?? local?.unit.stack?.blockedBelow ?? null;
    const hold = remote?.hold ?? local?.hold ?? null;
    const stage = stale && pr !== null && !pr.isDraft ? "review" : stageFor(lifecycle, pr, behind);
    const blocker = blockerFor(pr, stage, hold, behind, stale);
    let activity = hold === null ? activityFor(pr?.url ?? null, local?.key ?? null, sources) : NONE;
    if (hold === null && stage === "build" && activity.state === "none" && local?.cluster.units.length === 1 && local.cluster.threads.some((thread) => thread.active)) {
      const thread = local.cluster.threads.find((item) => item.active)!;
      activity = { state: "working", detail: thread.title, threadId: thread.id, source: "run" };
    }
    if (stage === "ready" && blocker.label === "Clear" && activity.state === "needs-you") activity = NONE;
    let action = primaryPipelineAction(stage, blocker, activity, hold, behind);
    if (action?.kind === "advance" && pr !== null) {
      const canStartBatch = pr.state === "OPEN" && pr.reviewDecision === "APPROVED";
      const canStartLocalAgent = local?.action?.kind === "agent" || local !== null && blocker.label === "CI failing";
      if (!canStartBatch && !canStartLocalAgent) action = { kind: "open-pr", label: "Open PR" };
    }
    if (pr !== null) covered.add(prWorkItemKey(pr.url));
    cards.push({ key: pr === null ? local!.key : prWorkItemKey(pr.url), repo: pr === null ? local!.repo : repoOf(pr, remote?.repo ?? local!.repo),
      title: pr === null ? local!.title : displayTitle(pr.title), pr, local, backlog: remote,
      effortKey: remote?.effortKey ?? local?.effortKey ?? null, effortName: remote?.effortName ?? local?.effort ?? null,
      hold, stage, blocker, activity, action, ageSince: ageOf(pr, local), stale });
  };
  for (const row of backlog) add(row.local, row);
  for (const local of [...locals].sort((a, b) => Number(b.unit.pr?.state === "MERGED" && b.unit.lifecycle === "shipped") - Number(a.unit.pr?.state === "MERGED" && a.unit.lifecycle === "shipped") ||
    Number(b.unit.rebasing === true) - Number(a.unit.rebasing === true) || a.key.localeCompare(b.key))) {
    if (local.unit.pr !== null && covered.has(prWorkItemKey(local.unit.pr.url))) continue;
    if (isTicketlessClone(local.unit)) continue;
    if (local.unit.pr !== null && local.unit.pr.state !== "OPEN" && local.unit.pr.state !== "MERGED") continue;
    add(local, null);
  }
  return cards.sort(byPipelineOrder);
}

function recentAt(card: PipelineCard): number | null {
  const sources = card.pr === null
    ? [card.local?.unit.lastCommitAt]
    : card.stage === "merged" || card.stage === "released"
      ? [card.pr.mergedAt, card.pr.updatedAt, card.pr.createdAt]
      : [card.pr.updatedAt, card.pr.createdAt];
  for (const source of sources) {
    const at = source ? Date.parse(source) : NaN;
    if (Number.isFinite(at)) return at;
  }
  return null;
}

export function byPipelineOrder(a: PipelineCard, b: PipelineCard): number {
  const aAt = recentAt(a) ?? Number.NEGATIVE_INFINITY;
  const bAt = recentAt(b) ?? Number.NEGATIVE_INFINITY;
  return PIPELINE_STAGES.indexOf(a.stage) - PIPELINE_STAGES.indexOf(b.stage) ||
    Number(a.hold !== null) - Number(b.hold !== null) ||
    (aAt === bAt ? a.key.localeCompare(b.key) : bAt - aAt);
}

export type PipelineColumn = { stage: PipelineStage; cards: PipelineCard[]; bulk: "nudge" | "advance" | "merge" | null; bulkCount: number };
/** The exact cards represented by a column bulk button, in the same sort order. */
export function pipelineBulkCards(cards: readonly PipelineCard[], stage: PipelineStage): PipelineCard[] {
  const bulk = stage === "review" ? "nudge" : stage === "feedback" ? "advance" : stage === "ready" ? "merge" : null;
  if (bulk === null) return [];
  return cards.filter((card) => card.stage === stage && card.hold === null && !card.stale &&
    (bulk === "advance" ? card.pr !== null && !card.pr.isDraft && isAdvanceEligible(card.pr) && card.activity.state !== "working" : card.action?.kind === bulk)).sort(byPipelineOrder);
}
export function pipelineColumns(cards: readonly PipelineCard[]): PipelineColumn[] {
  return PIPELINE_STAGES.map((stage) => {
    const members = cards.filter((card) => card.stage === stage).sort(byPipelineOrder);
    const bulk = stage === "review" ? "nudge" : stage === "feedback" ? "advance" : stage === "ready" ? "merge" : null;
    return { stage, cards: members, bulk, bulkCount: pipelineBulkCards(members, stage).length };
  });
}

export type PipelineEffort = { key: string | null; name: string; cards: PipelineCard[] };
export function pipelineEfforts(cards: readonly PipelineCard[]): PipelineEffort[] {
  const groups = new Map<string | null, PipelineEffort>();
  for (const card of cards) {
    const effort = groups.get(card.effortKey) ?? { key: card.effortKey, name: card.effortName ?? "One-offs", cards: [] };
    effort.cards.push(card);
    groups.set(card.effortKey, effort);
  }
  return [...groups.values()].sort((a, b) => a.key === null ? 1 : b.key === null ? -1 : a.name.localeCompare(b.name));
}
