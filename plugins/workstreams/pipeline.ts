// Pure presentation model for the Pipeline. GitHub and checkout facts remain the source of truth.
import type { Pr } from "./contract.js";
import type { Row } from "./inbox-rows.js";
import type { AdvanceBatch, AdvanceJob } from "./bulk-advance.js";
import type { DispatchState } from "./dispatch.js";
import type { PrHold, PrHolds } from "./pr-holds.js";
import { canonicalPrUrl } from "./pr-holds.js";
import { prBacklog, type BacklogEntry, type BacklogRow } from "./pr-backlog.js";
import type { WireRun } from "./server.js";
import { advancePrKey, selectVisibleOpen, type AdvanceSelection } from "./bulk-advance-selection.js";
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
  stage: PipelineStage; blocker: PipelineBlocker; activity: PipelineActivity; action: PipelineAction; nextStep: string;
  ageSince: number | null; stale: boolean;
};
export type PipelineSources = { holds?: PrHolds; batches?: readonly AdvanceBatch[]; dispatch?: DispatchState; runs?: readonly WireRun[];
  observations?: Readonly<Record<string, { checkedAt: string | null; failedAt: string | null }>> };

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
  if (pr === null) return { label: "In progress", tone: "wait" };
  if (stale) return { label: "Status unknown", tone: "wait" };
  if (checksFailed(pr.checkConclusions)) return { label: "CI failing", tone: "bad" };
  if (pr.mergeStateStatus === "DIRTY") return { label: "Conflicts", tone: "bad" };
  if (pr.reviewDecision === "CHANGES_REQUESTED" && !pr.reviewFollowupPosted) return { label: "Changes requested", tone: "warn" };
  if (pr.unresolvedReviewThreads !== null && pr.unresolvedReviewThreads > 0) return { label: `${pr.unresolvedReviewThreads} open threads`, tone: "warn" };
  if (pr.reviewDecision === "APPROVED" && pr.approvalFeedback?.status === "present" && !pr.approvalFeedbackVerified) {
    return { label: pr.approvalFeedbackVerification === "head-changed" ? "Verification needs recheck" :
      pr.approvalFeedbackVerification === "feedback-changed" ? "New review feedback" : "Feedback verification needed", tone: "warn" };
  }
  if (behind !== null) return { label: `Behind #${behind}`, tone: "wait" };
  if (pr.mergeStateStatus === "BEHIND") return { label: "Branch behind", tone: "wait" };
  if (pr.isDraft) return { label: "Draft", tone: "wait" };
  if (pr.reviewDecision === "APPROVED" && (!pr.approvalFeedback || pr.approvalFeedback.status === "unknown")) return { label: "Review history unknown", tone: "wait" };
  if (stage === "build") return { label: "In progress", tone: "wait" };
  if (pr.reviewDecision === "CHANGES_REQUESTED" && pr.reviewFollowupPosted) return { label: "Awaiting re-review", tone: "wait" };
  if (pr.reviewDecision === "APPROVED" && !checksGreen(pr.checkConclusions)) return { label: "Checks pending", tone: "wait" };
  if (pr.mergeStateStatus === "BLOCKED") return { label: "Rules block", tone: "wait" };
  if (pr.mergeStateStatus === "UNKNOWN" ||
    (pr.reviewDecision === "APPROVED" && pr.unresolvedReviewThreads === null)) return { label: "Status unknown", tone: "wait" };
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
  if (activity.state === "needs-you") return { kind: "fix", label: "Review blocker" };
  if (activity.state === "working") return stage === "build" && activity.threadId !== null ? { kind: "open-thread", label: "Open thread" } : null;
  if (stage === "build" && activity.threadId !== null) return { kind: "open-thread", label: "Open thread" };
  if (behind !== null) return { kind: "open-parent", label: "Open parent", behind };
  if (stage === "ready" && blocker.label === "Clear") return { kind: "merge", label: "Merge" };
  if (stage === "review" && blocker.label === "No reviewer") return { kind: "open-pr", label: "Choose reviewer" };
  if (stage === "review" && blocker.label === "Awaiting review") return { kind: "nudge", label: "Nudge" };
  return { kind: "advance", label: "Advance" };
}

/** Explain the current gate and the next deliberate action, including real waits. */
export function nextStepFor(pr: Pr | null, stage: PipelineStage, blocker: PipelineBlocker, activity: PipelineActivity, hold: PrHold | null, behind: number | null): string {
  if (hold !== null) return "Release the hold when work can resume.";
  if (stage === "released") return "No PR action remains.";
  if (stage === "merged") return "Check release status when needed.";
  if (activity.state === "working") return activity.threadId ? "Follow the running agent thread." : "Wait for the running agent.";
  if (blocker.label === "Verification needs recheck") return "Refresh GitHub status. Changed code still needs feedback verification.";
  if (activity.state === "needs-you") return "Review the agent result and remaining blocker.";
  if (pr === null) return "Open the checkout to continue branch work.";
  if (blocker.label === "Status unknown") return "Advance to refresh live PR status.";
  if (behind !== null) return `Advance parent PR #${behind} first.`;
  if (blocker.label === "CI failing") return "Advance to investigate failing checks.";
  if (blocker.label === "Conflicts" || blocker.label === "Branch behind") return "Advance to update the branch.";
  if (blocker.label === "Draft") return "Finish draft work; Advance checks for repairable blockers.";
  if (blocker.label === "Changes requested" || blocker.label === "New review feedback" || blocker.label === "Feedback verification needed" || blocker.label.endsWith("open threads")) return "Advance to address review feedback.";
  if (blocker.label === "Awaiting re-review") return "Wait for the reviewer to respond to the follow-up.";
  if (blocker.label === "Awaiting review") return "Nudge the requested reviewer or wait for review.";
  if (blocker.label === "No reviewer") return "Choose a reviewer on GitHub; Advance can recheck other gates.";
  if (blocker.label === "Checks pending") return "Wait for checks to finish; Advance can recheck status.";
  if (blocker.label === "Rules block") return "Inspect branch rules, then Advance to recheck.";
  if (stage === "ready") return "Review the merge preview, then merge.";
  if (stage === "build") return "Continue branch work; Advance checks for blockers.";
  return "Advance to check the remaining PR gates.";
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
    const observation = pr === null ? null : sources.observations?.[canonicalPrUrl(pr.url)?.toLowerCase() ?? pr.url.toLowerCase()];
    const failed = observation?.failedAt && (!observation.checkedAt || observation.failedAt >= observation.checkedAt);
    const stale = remote?.stale ?? (pr?.state === "OPEN" && !!failed);
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
    if (pr?.state !== "OPEN" && action?.kind === "advance") action = null;
    const nextStep = nextStepFor(pr, stage, blocker, activity, hold, behind);
    if (pr !== null) covered.add(prWorkItemKey(pr.url));
    cards.push({ key: pr === null ? local!.key : prWorkItemKey(pr.url), repo: pr === null ? local!.repo : repoOf(pr, remote?.repo ?? local!.repo),
      title: pr === null ? local!.title : displayTitle(pr.title), pr, local, backlog: remote,
      effortKey: remote?.effortKey ?? local?.effortKey ?? null, effortName: remote?.effortName ?? local?.effort ?? null,
      hold, stage, blocker, activity, action, nextStep, ageSince: ageOf(pr, local), stale });
  };
  for (const row of backlog) add(row.local, row);
  for (const local of [...locals].sort((a, b) => Number(b.unit.pr?.state === "MERGED" && b.unit.lifecycle === "shipped") - Number(a.unit.pr?.state === "MERGED" && a.unit.lifecycle === "shipped") ||
    Number(b.unit.rebasing === true) - Number(a.unit.rebasing === true) || a.key.localeCompare(b.key))) {
    if (local.unit.pr !== null && covered.has(prWorkItemKey(local.unit.pr.url))) continue;
    if (isTicketlessClone(local.unit)) continue;
    if (local.unit.pr !== null && local.unit.pr.state !== "OPEN" && local.unit.pr.state !== "MERGED") continue;
    add(local, null);
  }
  return orderPipelineCards(cards);
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

export type PipelineStackGraph = {
  parentByChild: ReadonlyMap<string, string>;
  childrenByParent: ReadonlyMap<string, readonly PipelineCard[]>;
};

/** Link only open PRs in the same repository; incomplete or cyclic stacks stay independent. */
export function pipelineStackGraph(cards: readonly PipelineCard[]): PipelineStackGraph {
  const byKey = new Map(cards.filter((card) => card.pr?.state === "OPEN").map((card) => [card.key, card]));
  const byRepoNumber = new Map<string, PipelineCard | null>();
  for (const card of byKey.values()) {
    const key = `${card.repo.toLowerCase()}#${card.pr!.number}`;
    byRepoNumber.set(key, byRepoNumber.has(key) ? null : card);
  }
  const parentByChild = new Map<string, string>();
  for (const child of byKey.values()) {
    const linked = child.backlog?.parent?.pr.url;
    const number = child.backlog?.parent?.pr.number ?? child.local?.unit.stack?.blockedBelow;
    const parent = linked ? byKey.get(prWorkItemKey(linked)) : number == null ? null : byRepoNumber.get(`${child.repo.toLowerCase()}#${number}`);
    if (parent && parent.key !== child.key && parent.repo.toLowerCase() === child.repo.toLowerCase()) parentByChild.set(child.key, parent.key);
  }
  for (const child of parentByChild.keys()) {
    const path: string[] = [];
    const seen = new Map<string, number>();
    let node: string | undefined = child;
    while (node !== undefined && !seen.has(node)) {
      seen.set(node, path.length);
      path.push(node);
      node = parentByChild.get(node);
    }
    if (node !== undefined) for (const cycleNode of path.slice(seen.get(node))) parentByChild.delete(cycleNode);
  }
  const childrenByParent = new Map<string, PipelineCard[]>();
  for (const [childKey, parentKey] of parentByChild) {
    const child = byKey.get(childKey)!;
    const children = childrenByParent.get(parentKey) ?? [];
    children.push(child);
    childrenByParent.set(parentKey, children);
  }
  for (const children of childrenByParent.values()) children.sort(byPipelineOrder);
  return { parentByChild, childrenByParent };
}

/** Keep prerequisites above visible dependents without changing stages or effort lanes. */
export function orderPipelineCards(cards: readonly PipelineCard[], graph = pipelineStackGraph(cards)): PipelineCard[] {
  const visible = new Set(cards.map((card) => card.key));
  const priority = (card: PipelineCard) => (graph.childrenByParent.get(card.key) ?? []).some((child) => visible.has(child.key) && child.hold === null);
  const compare = (a: PipelineCard, b: PipelineCard) => Number(priority(b)) - Number(priority(a)) || byPipelineOrder(a, b);
  const ordered: PipelineCard[] = [];
  for (const stage of PIPELINE_STAGES) for (const held of [false, true]) {
    const bucket = cards.filter((card) => card.stage === stage && (card.hold !== null) === held);
    if (stage === "merged" || stage === "released") {
      ordered.push(...bucket.sort(byPipelineOrder));
      continue;
    }
    const members = new Map(bucket.map((card) => [card.key, card]));
    const parentInBucket = (card: PipelineCard) => members.get(graph.parentByChild.get(card.key) ?? "");
    const visit = (card: PipelineCard): void => {
      ordered.push(card);
      for (const child of (graph.childrenByParent.get(card.key) ?? []).filter((item) => members.has(item.key)).sort(compare)) visit(child);
    };
    for (const root of bucket.filter((card) => !parentInBucket(card)).sort(compare)) visit(root);
  }
  return ordered;
}

export type PipelineColumn = { stage: PipelineStage; cards: PipelineCard[]; bulk: "nudge" | "advance" | "merge" | null; bulkCount: number };
/** The exact cards represented by a column bulk button, in the same sort order. */
export function pipelineBulkCards(cards: readonly PipelineCard[], stage: PipelineStage, graph = pipelineStackGraph(cards)): PipelineCard[] {
  const bulk = stage === "build" || stage === "review" || stage === "feedback" ? "advance" : stage === "ready" ? "merge" : null;
  if (bulk === null) return [];
  return orderPipelineCards(cards, graph).filter((card) => card.stage === stage && card.hold === null &&
    (bulk === "advance" ? card.pr?.state === "OPEN" : card.action?.kind === bulk));
}
export function pipelineColumns(cards: readonly PipelineCard[]): PipelineColumn[] {
  const ordered = orderPipelineCards(cards);
  return PIPELINE_STAGES.map((stage) => {
    const members = ordered.filter((card) => card.stage === stage);
    const bulk = stage === "build" || stage === "review" || stage === "feedback" ? "advance" : stage === "ready" ? "merge" : null;
    return { stage, cards: members, bulk, bulkCount: pipelineBulkCards(members, stage).length };
  });
}

export const selectablePipelineCard = (card: PipelineCard): boolean => card.pr?.state === "OPEN" && card.hold === null;

export function togglePipelineSelection(selection: AdvanceSelection, card: PipelineCard): AdvanceSelection {
  if (!selectablePipelineCard(card)) return selection;
  const url = advancePrKey(canonicalPrUrl(card.pr!.url) ?? card.pr!.url);
  return selection.urls.includes(url)
    ? { ...selection, urls: selection.urls.filter((item) => item !== url) }
    : { ...selection, urls: selectVisibleOpen(selection.urls, [{ url, state: "OPEN" }]) };
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
