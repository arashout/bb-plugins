// Where one PR's work order runs: existing checkouts and threads first. The
// checkout order is fixed: our last attempt's, the newest legacy Advance
// worktree, the origin thread's, the author's clean checkout at the PR head,
// then a new worktree at the effort's stable key. Threads in that checkout rank
// the same way. Everything passed over, and every new thread or worktree, names
// its reason, so the roster can say why. Pure: the runner reads threads and
// inspects each candidate checkout first; nothing here runs git, calls the SDK,
// or retitles or reparents a thread.
import type { AdvanceFacts, CheckoutInspection } from "./advance-contract.js";
import { configuredProviderError, type ModelChoice } from "./execution.js";
import type { LegacyAttempt } from "./legacy-history.js";
import { prWorkItemKey } from "./work-item-index.js";

/** A thread using this share of its context window or more hands off to a new thread in the same checkout. */
export const CONTEXT_HANDOFF = 0.7;

export type Workspace = { batchId: string; jobId: string };
/** One worktree per effort and PR, so every v2 attempt on the PR finds the same one again. */
export const v2Workspace = (effortId: string, number: number): Workspace => ({ batchId: `effort-${effortId}`, jobId: `pr-${number}` });

export type ResourceUnit = { path: string; githubRepo: string | null; branch: string | null; prUrl: string | null;
  /** The BB project and host its path maps to; null outside every project. */
  projectId: string | null; hostId: string | null };
export type ResourceThread = { id: string; providerId: string; status: string; archived: boolean; projectId: string; hostId: string | null;
  environmentPath: string | null; updatedAt: number;
  /** Share of the context window in use, 0-1, or null when BB doesn't report it. */
  contextUsed: number | null };
/** Anyone else writing the PR (`path` null) or a checkout: a legacy job, an action run, dispatch, a manual write, or an active thread. */
export type ResourceWriter = { owner: "legacy-job" | "run" | "dispatch" | "manual" | "thread"; ref: string; path: string | null };
export type ResourceAttempt = { id: string; status: "launching" | "running" | "uncertain" | "completed" | "failed" | "released";
  threadId: string | null; path: string | null; workspace: Workspace | null };

export type ResourceInput = {
  effortId: string;
  pr: Pick<AdvanceFacts, "prUrl" | "repo" | "number" | "headRefName" | "headOid" | "isDraft" | "isCrossRepository">;
  /** The primary host: v2 writes only there. */
  hostId: string;
  /** The configured model for the work order's role. A thread's provider is fixed, so only a thread on its provider is reusable. */
  model: ModelChoice;
  /** Scanned checkouts. */
  units: readonly ResourceUnit[];
  /** Live reads of the candidate paths: our last attempt's, the legacy worktree, and every scanned checkout of the repository. */
  inspections: ReadonlyMap<string, CheckoutInspection>;
  legacy: LegacyAttempt | null;
  /** Our newest attempt on the PR. */
  attempt: ResourceAttempt | null;
  /** The thread the PR started in, and the threads that link it directly. */
  origin: string | null;
  linked: readonly string[];
  /** Threads that may sit in a candidate checkout. */
  threads: readonly ResourceThread[];
  writers: readonly ResourceWriter[];
  /** An answer let v2 push beside unpushed commits in the author's checkout. */
  unpushedAllowed: boolean;
};

export type Checkout = { path: string; kind: "author" | "worktree"; hostId: string; projectId: string | null;
  /** How act time re-verifies a worktree through advanceWorkspace: its key and source repository. */
  workspace: (Workspace & { sourcePath: string }) | null;
  /** A clean detached worktree behind the PR head: detach it at the head before work. */
  moveCleanToHead: boolean };
export type Resource =
  | { kind: "attach"; attemptId: string; threadId: string | null; path: string | null }
  | { kind: "reuse"; threadId: string; checkout: Checkout }
  | { kind: "spawn"; checkout: Checkout; reason: string; references: string[] }
  | { kind: "worktree"; hostId: string; projectId: string | null; workspace: Workspace & { sourcePath: string }; reason: string; references: string[] }
  | { kind: "wait"; cause: "writer-available" | "legacy-drain" | "draft"; reason: string; ref: string | null }
  | { kind: "decision"; cause: "authority"; reason: string }
  | { kind: "repair"; cause: "fork" | "no-clone" | "host-mismatch" | "ambiguous-checkout" | "unpushed-worktree"; reason: string };

const CLAIMS = new Set<ResourceAttempt["status"]>(["launching", "running", "uncertain"]);
const samePath = (a: string, b: string) => a.replace(/\/+$/u, "") === b.replace(/\/+$/u, "");

/** Someone else is writing the PR itself: a live legacy Advance job, or another writer. */
export function prWriter({ legacy, writers }: Pick<ResourceInput, "legacy" | "writers">): Extract<Resource, { kind: "wait" }> | null {
  if (legacy && ["queued", "running", "uncertain"].includes(legacy.cause))
    return { kind: "wait", cause: "legacy-drain", reason: `Legacy Advance: ${legacy.label}`, ref: `${legacy.batchId}/${legacy.job.id}` };
  const writer = writers.find((item) => item.path === null);
  return writer ? writerWait(writer) : null;
}
const WRITER: Record<ResourceWriter["owner"], string> = { "legacy-job": "Legacy Advance job", run: "Action run", dispatch: "Dispatch", manual: "Manual write", thread: "Thread" };
function writerWait(writer: ResourceWriter): Extract<Resource, { kind: "wait" }> {
  return { kind: "wait", cause: writer.owner === "legacy-job" ? "legacy-drain" : "writer-available",
    reason: `${WRITER[writer.owner]} ${writer.ref} is writing ${writer.path ? `in ${writer.path}` : "this PR"}`, ref: writer.ref };
}

/** The legacy Advance worker threads for the PR, newest first. */
function legacyThreads(legacy: LegacyAttempt | null): string[] {
  if (!legacy) return [];
  const current = [legacy.job.threadId, ...legacy.job.previousAttempts.map((prior) => prior.threadId).reverse()];
  return [...new Set([...legacy.reusable?.threadIds ?? [], ...current].filter((id) => id !== null))];
}

export function selectResource(input: ResourceInput): Resource {
  const { pr, attempt, legacy, hostId } = input;
  if (attempt && CLAIMS.has(attempt.status)) return { kind: "attach", attemptId: attempt.id, threadId: attempt.threadId, path: attempt.path };
  const busy = prWriter(input);
  if (busy) return busy;
  if (pr.isCrossRepository) return { kind: "repair", cause: "fork", reason: "Fork PRs need manual preparation; v2 can't push their branch." };

  const target = prWorkItemKey(pr.prUrl);
  const repository = input.units.filter((unit) => unit.githubRepo?.toLowerCase() === pr.repo.toLowerCase());
  // The same branch name in another repository is not this PR's checkout.
  const exact = (unit: ResourceUnit) => unit.prUrl !== null && prWorkItemKey(unit.prUrl) === target && unit.branch === pr.headRefName;
  const authors = repository.filter((unit) => exact(unit) && unit.hostId === hostId);
  // Like legacy Advance, a new worktree comes from the PR's own checkout when there is one; it never touches that working tree.
  const sources = repository.filter((unit) => unit.hostId === hostId).sort((a, b) => Number(exact(b)) - Number(exact(a)) || a.path.localeCompare(b.path));
  const source = sources[0] ?? null;
  const read = (path: string) => input.inspections.get(path) ?? { ok: false as const, error: "not inspected" };
  const skipped = new Set<string>();
  const skip = (reason: string) => { skipped.add(reason); return null; };

  // Commits the author hasn't pushed: any push, from any checkout, would fork the branch under them.
  const ahead = input.unpushedAllowed ? undefined
    : authors.find((unit) => { const found = read(unit.path); return found.ok && found.branch === pr.headRefName && found.relation === "diverged"; });
  if (ahead) return { kind: "decision", cause: "authority", reason: `Unpushed commits in ${ahead.path}` };

  const worktree = (path: string, workspace: Workspace): Checkout | null => {
    const found = read(path);
    if (!found.ok) return skip(`${path} can't be read: ${found.error}`);
    const from = sources.find((unit) => { const scanned = read(unit.path); return scanned.ok && scanned.commonDir === found.commonDir; });
    if (!from) return skip(`${path} isn't a worktree of a scanned ${pr.repo} checkout on ${hostId}`);
    if (!found.clean) return skip(`uncommitted changes in ${path}`);
    if (found.relation === "diverged") return skip(`unpushed or rewritten commits in ${path}`);
    // Behind, or older than a PR head it hasn't fetched: act time fetches the head, and moves the worktree only if HEAD is its ancestor.
    return { path, kind: "worktree", hostId, projectId: from.projectId, moveCleanToHead: found.relation !== "at-head",
      workspace: { batchId: workspace.batchId, jobId: workspace.jobId, sourcePath: from.path } };
  };
  // v2 never moves an author's branch, so only a clean checkout already at the PR head qualifies.
  const author = (unit: ResourceUnit): Checkout | null => {
    const found = read(unit.path);
    if (!found.ok) return skip(`${unit.path} can't be read: ${found.error}`);
    if (found.branch !== pr.headRefName) return skip(`${unit.path} is now on ${found.branch ?? "a detached HEAD"}`);
    if (!found.clean) return skip(`uncommitted changes in ${unit.path}`);
    if (found.relation === "diverged") return skip(`unpushed commits in ${unit.path}`);
    if (found.relation !== "at-head") return skip(`author checkout behind remote in ${unit.path}`);
    return { path: unit.path, kind: "author", hostId, projectId: unit.projectId, workspace: null, moveCleanToHead: false };
  };
  const authorAt = (path: string | null | undefined) => {
    const unit = path ? authors.find((item) => samePath(item.path, path)) : undefined;
    return unit ? author(unit) : null;
  };
  const recency = (path: string) => Math.max(0, ...input.threads.filter((thread) => thread.environmentPath !== null && samePath(thread.environmentPath, path)).map((thread) => thread.updatedAt));
  // Clean author checkouts of the branch at different commits, any of which may hold unpushed work: which one the author works in would be a guess.
  // One provably behind the head holds nothing the PR lacks, so it is only skipped.
  const clean = authors.flatMap((unit) => { const found = read(unit.path);
    return found.ok && found.clean && found.branch === pr.headRefName && (found.relation === "at-head" || found.relation === "unknown") ? [{ path: unit.path, head: found.head }] : []; });
  const ambiguous = new Set(clean.map((item) => item.head)).size > 1;
  const stable = v2Workspace(input.effortId, pr.number);
  const ownWorktree = attempt?.workspace?.batchId === stable.batchId && attempt.workspace.jobId === stable.jobId ? attempt.path : null;
  const references = [...new Set([input.origin, attempt?.threadId ?? null, ...legacyThreads(legacy)].filter((id) => id !== null))];

  const checkout = (attempt?.path ? attempt.workspace ? worktree(attempt.path, attempt.workspace) : authorAt(attempt.path) : null)
    ?? (legacy?.reusable ? worktree(legacy.reusable.path, legacy.reusable) : null)
    ?? authorAt(input.threads.find((thread) => thread.id === input.origin)?.environmentPath)
    ?? (ambiguous ? null : authors.map(author).filter((item) => item !== null).sort((a, b) => recency(b.path) - recency(a.path) || a.path.localeCompare(b.path))[0] ?? null);
  if (!checkout && ambiguous)
    return { kind: "repair", cause: "ambiguous-checkout", reason: `${clean.map((item) => item.path).join(" and ")} hold different commits of ${pr.headRefName}` };
  if (!checkout) {
    if (pr.isDraft) return { kind: "wait", cause: "draft", reason: skipped.size ? `no usable checkout for a draft: ${[...skipped].join("; ")}` : "no checkout for a draft", ref: null };
    // Our own worktree still holds work: a new one at the same key would have to replace it.
    if (ownWorktree && read(ownWorktree).ok)
      return { kind: "repair", cause: "unpushed-worktree", reason: `${[...skipped].join("; ")}; the work in ${ownWorktree} is preserved` };
    if (!source) {
      const elsewhere = repository.find((unit) => unit.hostId !== hostId);
      return elsewhere ? { kind: "repair", cause: "host-mismatch", reason: `${pr.repo} is checked out at ${elsewhere.path} on ${elsewhere.hostId ?? "no BB project"}, not ${hostId}` }
        : { kind: "repair", cause: "no-clone", reason: `No scanned ${pr.repo} repository on ${hostId}` };
    }
    return { kind: "worktree", hostId, projectId: source.projectId, workspace: { ...stable, sourcePath: source.path },
      reason: skipped.size ? [...skipped].join("; ") : `no checkout on ${hostId}`, references };
  }

  const writer = input.writers.find((item) => item.path !== null && samePath(item.path, checkout.path));
  if (writer) return writerWait(writer);
  const here = input.threads.filter((thread) => !thread.archived && thread.hostId === hostId && thread.projectId === checkout.projectId
    && thread.environmentPath !== null && samePath(thread.environmentPath, checkout.path));
  const active = here.find((thread) => !["idle", "error"].includes(thread.status));
  if (active) return { kind: "wait", cause: "writer-available", reason: `Thread ${active.id} is active in ${checkout.path}`, ref: active.id };
  // Our last worker, then the legacy workers, then the origin, then direct links, then the most recent.
  const ranked = [attempt?.threadId, ...legacyThreads(legacy), input.origin];
  const rank = (id: string) => { const index = ranked.indexOf(id); return index >= 0 ? index : input.linked.includes(id) ? ranked.length : ranked.length + 1; };
  const passed: string[] = [];
  for (const thread of here.sort((a, b) => rank(a.id) - rank(b.id) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))) {
    if (thread.status !== "idle") passed.push(`${thread.id} stopped with an error`);
    else if (configuredProviderError(thread, input.model)) passed.push(`${thread.id} runs on ${thread.providerId}, not the configured ${input.model.providerId}`);
    else if (thread.contextUsed !== null && thread.contextUsed >= CONTEXT_HANDOFF) passed.push(`context ${Math.round(thread.contextUsed * 100)}% full in ${thread.id}`);
    else return { kind: "reuse", threadId: thread.id, checkout };
  }
  return { kind: "spawn", checkout, reason: passed.length ? passed.join("; ") : `no idle thread in ${checkout.path}`, references };
}
