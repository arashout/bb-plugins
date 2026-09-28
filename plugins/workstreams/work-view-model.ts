// Pure presentation model for durable Work conversations and preparation batches.
import type { AdvanceBatch, AdvanceJob } from "./bulk-advance.js";
import type { PipelineCard } from "./pipeline.js";
import { prWorkItemKey } from "./work-item-index.js";
import type { WorkConversation } from "./work-conversation.js";

export type WorkRequest = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  conversationId: string | null;
  threadId: string | null;
  prUrls: string[];
  batches: AdvanceBatch[];
  jobs: { batchId: string; job: AdvanceJob }[];
  status: "working" | "waiting" | "attention" | "ready" | "not-started" | "finished";
  nextStep: string;
};

type LinkedJob = WorkRequest["jobs"][number];
const ACTIVE = new Set<AdvanceJob["status"]>(["queued", "launching", "running", "verifying"]);
const key = prWorkItemKey;

function latestJobs(batches: readonly AdvanceBatch[]): LinkedJob[] {
  const latest = new Map<string, { entry: LinkedJob; createdAt: number }>();
  for (const batch of batches) for (const job of batch.jobs) {
    const current = latest.get(key(job.prUrl));
    if (!current || Number(ACTIVE.has(job.status)) > Number(ACTIVE.has(current.entry.job.status)) ||
      (ACTIVE.has(job.status) === ACTIVE.has(current.entry.job.status) &&
        (job.updatedAt > current.entry.job.updatedAt || (job.updatedAt === current.entry.job.updatedAt && batch.createdAt >= current.createdAt)))) {
      latest.set(key(job.prUrl), { entry: { batchId: batch.id, job }, createdAt: batch.createdAt });
    }
  }
  return [...latest.values()].map(({ entry }) => entry);
}

/** Current Pipeline gates decide readiness; a job only describes this preparation attempt. */
export function workItemStatus(card: PipelineCard | undefined, job: AdvanceJob | undefined): Pick<WorkRequest, "status" | "nextStep"> {
  if (job?.uncertain) return { status: "attention", nextStep: "Inspect the worker thread and recheck the attempt before retrying." };
  if (job && ACTIVE.has(job.status)) return { status: "working", nextStep: job.status === "queued"
    ? "Preparation is queued." : job.threadId ? "Follow the active preparation thread." : "Preparation is in progress." };
  if (job?.hiddenFromProgress) return { status: "finished", nextStep: "Preparation was removed from progress. Review current PR status before starting more work." };
  if (job?.status === "cancelled") return { status: "finished", nextStep: "Preparation was stopped before queued work started." };
  if (job?.status === "merged" || job?.status === "closed") return { status: "finished", nextStep: "No preparation work remains for this PR." };
  if (card?.stage === "merged" || card?.stage === "released") return { status: "finished", nextStep: card.nextStep };
  if (card?.action?.kind === "merge") return { status: "ready", nextStep: card.nextStep };
  if (card?.stage === "ready" && card.blocker.label.startsWith("Behind #")) return { status: "waiting", nextStep: `Parent PR ${card.blocker.label.slice(7)} must merge before this PR can merge.` };
  if (job?.status === "needs-attention") return { status: "attention", nextStep: job.detail || "Review the preparation result and current PR blocker." };
  if (job?.status === "ready" && (!card || card.stale)) return { status: "attention", nextStep: "Refresh live PR status before treating this work as ready to merge." };
  if (card?.stale || card?.blocker.tone === "bad" || card?.blocker.tone === "warn") return { status: "attention", nextStep: card.nextStep };
  if (job?.status === "waiting-review" || job?.status === "waiting-checks" || card?.hold ||
    card?.action?.kind === "open-parent" || card?.action?.kind === "nudge" ||
    card?.blocker.label === "Checks pending" || card?.blocker.label === "Awaiting review") {
    return { status: "waiting", nextStep: card?.nextStep ?? (job?.status === "waiting-review"
      ? "Wait for review, then recheck the PR." : "Wait for checks, then recheck the PR.") };
  }
  if (card) return { status: "not-started", nextStep: card.nextStep };
  if (job?.status === "ready") return { status: "not-started", nextStep: "Review current PR status before starting preparation." };
  return { status: job ? "finished" : "not-started", nextStep: job ? "No preparation work remains for this PR." : "Review the selected PR and propose preparation." };
}

function describe(request: WorkRequest, cards: ReadonlyMap<string, PipelineCard>, owners: ReadonlyMap<string, LinkedJob>): Pick<WorkRequest, "status" | "nextStep"> {
  const owned = new Map(request.jobs.filter((entry) => owners.get(key(entry.job.prUrl))?.job === entry.job)
    .map((entry) => [key(entry.job.prUrl), entry.job]));
  if (request.batches.length && owned.size === 0) return { status: "finished", nextStep: "A newer preparation request superseded this batch. Review the current request." };
  const statuses = [...owned.values()].map((job) => workItemStatus(cards.get(key(job.prUrl)), job));
  const rank: Record<WorkRequest["status"], number> = { working: 0, attention: 1, ready: 2, waiting: 3, "not-started": 4, finished: 5 };
  statuses.sort((a, b) => rank[a.status] - rank[b.status]);
  return statuses[0] ?? { status: "finished", nextStep: "No preparation work remains for this request." };
}

/** One row per conversation; only unlinked batches receive their own row. */
export function workRequests(conversations: readonly WorkConversation[], batches: readonly AdvanceBatch[], cards: readonly PipelineCard[]): WorkRequest[] {
  const byBatch = new Map(batches.map((batch) => [batch.id, batch]));
  const linked = new Set(conversations.flatMap((conversation) => conversation.batchIds));
  const byCard = new Map(cards.map((card) => [card.pr ? key(card.pr.url) : card.key, card]));
  const owners = new Map<string, LinkedJob>();
  for (const entry of latestJobs(batches)) owners.set(key(entry.job.prUrl), entry);
  const requests: WorkRequest[] = conversations.map((conversation) => {
    const attached = conversation.batchIds.flatMap((id) => byBatch.get(id) ? [byBatch.get(id)!] : []);
    const jobs = latestJobs(attached);
    return { id: `conversation:${conversation.id}`, title: conversation.instruction.trim() || conversation.proposal?.instruction.trim() || "Plan selected PRs",
      createdAt: conversation.createdAt, updatedAt: Math.max(conversation.updatedAt, ...jobs.map(({ job }) => job.updatedAt)),
      conversationId: conversation.id, threadId: conversation.threadId, prUrls: [...conversation.scopePrUrls], batches: attached, jobs,
      status: "not-started", nextStep: "" };
  });
  for (const batch of batches) if (!linked.has(batch.id)) {
    requests.push({ id: `batch:${batch.id}`, title: batch.instruction?.trim() || (batch.jobs.length === 1
      ? `${batch.jobs[0]!.repo} #${batch.jobs[0]!.number}: ${batch.jobs[0]!.title}`
      : `Prepare ${batch.jobs.length} PRs`),
      createdAt: batch.createdAt, updatedAt: Math.max(batch.createdAt, ...batch.jobs.map((job) => job.updatedAt)), conversationId: null,
      threadId: null, prUrls: [...new Map(batch.jobs.map((job) => [key(job.prUrl), job.prUrl])).values()], batches: [batch], jobs: latestJobs([batch]),
      status: "not-started", nextStep: "" });
  }
  for (const request of requests) {
    request.jobs = request.jobs.filter((entry) => owners.get(key(entry.job.prUrl))?.job === entry.job);
    const conversation = request.conversationId === null ? undefined : conversations.find((item) => item.id === request.conversationId);
    Object.assign(request, conversation && request.batches.length === 0
      ? conversation.batchIds.length
        ? { status: "attention", nextStep: "Preparation history is unavailable. Refresh this conversation before starting more work." }
        : conversation.proposal
          ? { status: "not-started", nextStep: "Review the proposal and start preparation when ready." }
          : { status: "not-started", nextStep: "Review the selected PRs and propose preparation." }
      : describe(request, byCard, owners));
  }
  return requests.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}
