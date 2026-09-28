import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CheckoutInspection } from "./advance-contract.js";
import { DEFAULT_EFFECTS } from "./effort-command.js";
import { buildWorkOrder } from "./effort-recipes.js";
import { selectResource, type Resource, type ResourceInput, type ResourceThread, type ResourceUnit } from "./effort-resources.js";
import type { ModelChoice } from "./execution.js";
import { INKWELL_ADVANCE_BATCHES } from "./inkwell-fixtures.js";
import { currentLegacyAttempts, type LegacyAttempt } from "./legacy-history.js";

const legacy = currentLegacyAttempts(INKWELL_ADVANCE_BATCHES);
const PR_URL = "https://github.com/inkwell/folio/pull/313";
// The recorded shape: the newest legacy job for folio #313 ran without a worktree, and an older batch left one with its worker thread.
const LEGACY = legacy.get(PR_URL)!;
const WORKTREE = LEGACY.reusable!.path;
const HEAD = LEGACY.job.headOid;
const HOST = "host_reader";
const PROJECT = "proj_folio";
const SOURCE = "/Users/reader/src/folio";
const AUTHOR = "/Users/reader/src/folio-abc-340";
const GIT_DIR = "/Users/reader/src/folio/.git";
const CODEX: ModelChoice = { providerId: "codex", model: "gpt-6-sol", reasoningLevel: "high" };

const read = (overrides: Partial<Extract<CheckoutInspection, { ok: true }>> = {}): CheckoutInspection =>
  ({ ok: true, head: HEAD, branch: null, clean: true, commonDir: GIT_DIR, relation: "at-head", ...overrides });
const unit = (path: string, overrides: Partial<ResourceUnit> = {}): ResourceUnit =>
  ({ path, githubRepo: "inkwell/folio", branch: "main", prUrl: null, projectId: PROJECT, hostId: HOST, ...overrides });
const author = (path = AUTHOR, overrides: Partial<ResourceUnit> = {}) => unit(path, { branch: "abc-340", prUrl: PR_URL, ...overrides });
const thread = (id: string, path: string, overrides: Partial<ResourceThread> = {}): ResourceThread =>
  ({ id, providerId: "codex", status: "idle", archived: false, projectId: PROJECT, hostId: HOST, environmentPath: path, updatedAt: 1, contextUsed: 0.2, ...overrides });
const legacyThread = LEGACY.reusable!.threadIds[0]!;

/** Every call also checks the rule that every result other than reuse names its reason. */
function select(overrides: Partial<ResourceInput> = {}, inspections: [string, CheckoutInspection][] = []): Resource {
  const result = selectResource({
    effortId: "e-shelving", hostId: HOST, model: CODEX,
    pr: { prUrl: PR_URL, repo: "inkwell/folio", number: 313, headRefName: "abc-340", headOid: HEAD, isDraft: false, isCrossRepository: false },
    units: [unit(SOURCE)], inspections: new Map([[SOURCE, read({ branch: "main", head: "a".repeat(40), relation: "diverged" })], ...inspections]),
    legacy: null, attempt: null, origin: null, linked: [], threads: [], writers: [], unpushedAllowed: false,
    ...overrides,
  });
  if (result.kind !== "reuse" && result.kind !== "attach") expect(result.reason, result.kind).not.toBe("");
  return result;
}
const withLegacy = (overrides: Partial<ResourceInput> = {}, worktree: Partial<Extract<CheckoutInspection, { ok: true }>> = {}) =>
  select({ legacy: LEGACY, threads: [thread(legacyThread, WORKTREE)], ...overrides }, [[WORKTREE, read(worktree)]]);
const stableKey = { batchId: "effort-e-shelving", jobId: "pr-313", sourcePath: SOURCE };

describe("reuse-first resource selection", () => {
  it("reuses an exact author checkout at the PR head with its idle origin thread", () => {
    expect(select({ units: [unit(SOURCE), author()], origin: "thr_origin", threads: [thread("thr_origin", AUTHOR)] }, [[AUTHOR, read({ branch: "abc-340" })]]))
      .toEqual({ kind: "reuse", threadId: "thr_origin", checkout: { path: AUTHOR, kind: "author", hostId: HOST, projectId: PROJECT, workspace: null, moveCleanToHead: false } });
    // The origin thread's checkout comes before a more recently active one.
    const second = "/Users/reader/src/folio-review";
    expect(select({ units: [unit(SOURCE), author(), author(second)], origin: "thr_origin", threads: [thread("thr_origin", AUTHOR), thread("thr_new", second, { updatedAt: 9 })] },
      [[AUTHOR, read({ branch: "abc-340" })], [second, read({ branch: "abc-340" })]])).toMatchObject({ kind: "reuse", threadId: "thr_origin", checkout: { path: AUTHOR } });
  });

  it("reuses only an unarchived thread in the checkout's project on the primary host", () => {
    for (const other of [{ archived: true }, { hostId: "host_laptop" }, { projectId: "proj_quill" }])
      expect(withLegacy({ threads: [thread(legacyThread, WORKTREE, other)] }), JSON.stringify(other)).toMatchObject({ kind: "spawn", reason: `no idle thread in ${WORKTREE}` });
  });

  it("reuses the newest legacy Advance worktree and its worker thread through that job's own key, ahead of an author checkout", () => {
    expect(LEGACY.job.path).toBeNull();
    expect(withLegacy({ units: [unit(SOURCE), author()] }, {})).toEqual({ kind: "reuse", threadId: legacyThread,
      checkout: { path: WORKTREE, kind: "worktree", hostId: HOST, projectId: PROJECT, moveCleanToHead: false,
        workspace: { batchId: LEGACY.reusable!.batchId, jobId: LEGACY.reusable!.jobId, sourcePath: SOURCE } } });
  });

  it("moves a clean legacy worktree to the head only when it can hold no unpushed commits", () => {
    for (const relation of ["behind", "unknown"] as const)
      expect(withLegacy({}, { relation, head: "9".repeat(40) })).toMatchObject({ kind: "reuse", checkout: { path: WORKTREE, moveCleanToHead: true } });
    expect(withLegacy({}, { relation: "diverged", head: "9".repeat(40) }))
      .toEqual({ kind: "worktree", hostId: HOST, projectId: PROJECT, workspace: stableKey, reason: `unpushed or rewritten commits in ${WORKTREE}`, references: [legacyThread] });
    expect(withLegacy({}, { clean: false })).toMatchObject({ kind: "worktree", reason: `uncommitted changes in ${WORKTREE}` });
    // A worktree some other repository owns is never reused, even when clean at the head.
    expect(withLegacy({}, { commonDir: "/Users/reader/src/folio-old/.git" })).toMatchObject({ kind: "worktree", reason: expect.stringContaining("isn't a worktree of") });
  });

  it("waits for a legacy Advance job that is still active or uncertain instead of racing it", () => {
    const running = legacy.get("https://github.com/inkwell/atlas/pull/407")!;
    expect(running.job.status).toBe("running");
    expect(select({ legacy: running })).toMatchObject({ kind: "wait", cause: "legacy-drain", ref: `${running.batchId}/${running.job.id}` });
    const uncertain: LegacyAttempt = { ...LEGACY, cause: "uncertain", label: "Launch outcome uncertain", job: { ...LEGACY.job, uncertain: true } };
    expect(withLegacy({ legacy: uncertain })).toMatchObject({ kind: "wait", cause: "legacy-drain" });
  });

  it("starts a new thread in the legacy worktree when its worker runs on another provider, referencing the legacy and origin threads", () => {
    const result = withLegacy({ origin: "thr_origin", threads: [thread(legacyThread, WORKTREE, { providerId: "claude" })] });
    expect(result).toMatchObject({ kind: "spawn", checkout: { path: WORKTREE, kind: "worktree" }, reason: `${legacyThread} runs on claude, not the configured codex` });
    expect(result.kind === "spawn" && result.references).toEqual(["thr_origin", legacyThread]);
  });

  it("checks the configured provider, not a fixed one", () => {
    const claude: ModelChoice = { providerId: "claude", model: "opus", reasoningLevel: "high" };
    expect(withLegacy({ model: claude, threads: [thread(legacyThread, WORKTREE, { providerId: "claude" })] })).toMatchObject({ kind: "reuse", threadId: legacyThread });
    expect(withLegacy({ model: claude })).toMatchObject({ kind: "spawn", reason: `${legacyThread} runs on codex, not the configured claude` });
  });

  it("keeps the origin as a reference when its thread can't take the work", () => {
    const result = select({ units: [unit(SOURCE), author()], origin: "thr_origin", threads: [thread("thr_origin", AUTHOR, { providerId: "claude" })] },
      [[AUTHOR, read({ branch: "abc-340" })]]);
    expect(result).toMatchObject({ kind: "spawn", checkout: { path: AUTHOR, kind: "author" }, references: ["thr_origin"] });
  });

  it("works beside a dirty or behind author checkout in a new worktree, naming why, and never moves the author's branch", () => {
    const beside = (inspection: CheckoutInspection) => select({ units: [unit(SOURCE), author()] }, [[AUTHOR, inspection]]);
    // Like legacy Advance, the worktree comes from the PR's own repository without touching its working tree.
    expect(beside(read({ branch: "abc-340", clean: false }))).toEqual({ kind: "worktree", hostId: HOST, projectId: PROJECT, workspace: { ...stableKey, sourcePath: AUTHOR },
      reason: `uncommitted changes in ${AUTHOR}`, references: [] });
    expect(beside(read({ branch: "abc-340", relation: "behind", head: "9".repeat(40) }))).toMatchObject({ kind: "worktree", reason: `author checkout behind remote in ${AUTHOR}` });
    // An author checkout on the PR head but off its branch would push from somewhere the author isn't working.
    expect(beside(read({ branch: null }))).toMatchObject({ kind: "worktree", reason: `${AUTHOR} is now on a detached HEAD` });
  });

  it("asks before any push while the author's checkout holds unpushed commits, even with a legacy worktree ready", () => {
    const ahead: [string, CheckoutInspection][] = [[WORKTREE, read()], [AUTHOR, read({ branch: "abc-340", relation: "diverged", head: "9".repeat(40) })]];
    expect(select({ legacy: LEGACY, units: [unit(SOURCE), author()] }, ahead)).toEqual({ kind: "decision", cause: "authority", reason: `Unpushed commits in ${AUTHOR}` });
    // Allowed, the work runs beside that checkout, never in it.
    expect(select({ legacy: LEGACY, units: [unit(SOURCE), author()], unpushedAllowed: true }, ahead)).toMatchObject({ kind: "spawn", checkout: { path: WORKTREE } });
    expect(select({ units: [unit(SOURCE), author()], unpushedAllowed: true }, ahead.slice(1)))
      .toMatchObject({ kind: "worktree", workspace: { batchId: "effort-e-shelving" }, reason: `unpushed commits in ${AUTHOR}` });
  });

  it("names a repair for author checkouts at different commits, or a checkout only on another host", () => {
    const second = "/Users/reader/src/folio-review";
    const both = (relation: "behind" | "unknown") => select({ units: [unit(SOURCE), author(), author(second)] },
      [[AUTHOR, read({ branch: "abc-340" })], [second, read({ branch: "abc-340", relation, head: "9".repeat(40) })]]);
    // One that may hold unpushed work makes the choice a guess; one provably behind the head is a stale clone, skipped.
    expect(both("unknown")).toMatchObject({ kind: "repair", cause: "ambiguous-checkout", reason: `${AUTHOR} and ${second} hold different commits of abc-340` });
    expect(both("behind")).toMatchObject({ kind: "spawn", checkout: { path: AUTHOR, kind: "author" } });
    // Several clean checkouts at the same head resolve by the most recently active thread, then by path.
    expect(select({ units: [unit(SOURCE), author(), author(second)], threads: [thread("thr_old", AUTHOR, { updatedAt: 1 }), thread("thr_new", second, { updatedAt: 9 })] },
      [[AUTHOR, read({ branch: "abc-340" })], [second, read({ branch: "abc-340" })]])).toMatchObject({ kind: "reuse", threadId: "thr_new", checkout: { path: second } });
    // v2 writes only on the primary host, even in an author checkout at the head.
    const laptop: [string, CheckoutInspection][] = [[AUTHOR, read({ branch: "abc-340" })]];
    expect(select({ units: [unit(SOURCE, { hostId: "host_laptop" }), author(AUTHOR, { hostId: "host_laptop" })] }, laptop))
      .toMatchObject({ kind: "repair", cause: "host-mismatch", reason: expect.stringContaining("host_laptop") });
    expect(select({ units: [unit(SOURCE), author(AUTHOR, { hostId: "host_laptop" })] }, laptop)).toMatchObject({ kind: "worktree", reason: `no checkout on ${HOST}` });
  });

  it("never takes the same branch name in another repository for this PR's checkout", () => {
    // The scan once bound a PR by branch name alone; the repository must match too.
    const quill = unit("/Users/reader/src/quill-abc-340", { githubRepo: "inkwell/quill", branch: "abc-340", prUrl: PR_URL });
    expect(select({ units: [unit(SOURCE), quill], threads: [thread("thr_quill", quill.path)] }, [[quill.path, read({ branch: "abc-340" })]]))
      .toMatchObject({ kind: "worktree", reason: `no checkout on ${HOST}` });
  });

  it("waits for another writer on the PR or in the chosen checkout, and attaches to our own running attempt", () => {
    expect(withLegacy({ writers: [{ owner: "thread", ref: "thr_teammate", path: null }] })).toMatchObject({ kind: "wait", cause: "writer-available", ref: "thr_teammate" });
    expect(withLegacy({ writers: [{ owner: "run", ref: "run_7", path: WORKTREE }] })).toMatchObject({ kind: "wait", cause: "writer-available", ref: "run_7" });
    expect(withLegacy({ threads: [thread(legacyThread, WORKTREE), thread("thr_busy", WORKTREE, { status: "active" })] }))
      .toMatchObject({ kind: "wait", cause: "writer-available", ref: "thr_busy" });
    expect(withLegacy({ attempt: { id: "A-1", status: "running", threadId: "thr_v2", path: WORKTREE, workspace: null } }))
      .toEqual({ kind: "attach", attemptId: "A-1", threadId: "thr_v2", path: WORKTREE });
    // An uncertain launch may have a live worker: it keeps its claim until readback, never a second resource.
    expect(withLegacy({ attempt: { id: "A-1", status: "uncertain", threadId: null, path: null, workspace: null } })).toMatchObject({ kind: "attach", attemptId: "A-1" });
  });

  it("returns to our last attempt's worktree first, and preserves it when it holds work", () => {
    const own = "/Users/reader/.bb/plugins/workstreams/worktrees/effort-e-shelving/inkwell--folio/pr-313";
    const attempt = { id: "A-1", status: "completed" as const, threadId: "thr_v2", path: own, workspace: { batchId: "effort-e-shelving", jobId: "pr-313" } };
    expect(select({ legacy: LEGACY, attempt, threads: [thread(legacyThread, WORKTREE), thread("thr_v2", own)] }, [[own, read()], [WORKTREE, read()]]))
      .toMatchObject({ kind: "reuse", threadId: "thr_v2", checkout: { path: own, workspace: stableKey } });
    // Gone, it falls back to the legacy worktree; holding unpushed work with nothing else usable, it is a repair.
    expect(withLegacy({ attempt })).toMatchObject({ kind: "reuse", checkout: { path: WORKTREE } });
    expect(select({ attempt }, [[own, read({ relation: "diverged", head: "9".repeat(40) })]]))
      .toMatchObject({ kind: "repair", cause: "unpushed-worktree", reason: `unpushed or rewritten commits in ${own}; the work in ${own} is preserved` });
  });

  it("creates a worktree at the effort's stable key only from a scanned source, and repairs forks and missing clones", () => {
    expect(select()).toEqual({ kind: "worktree", hostId: HOST, projectId: PROJECT, workspace: stableKey, reason: `no checkout on ${HOST}`, references: [] });
    expect(select({ units: [] })).toMatchObject({ kind: "repair", cause: "no-clone" });
    const fork = select({ pr: { prUrl: PR_URL, repo: "inkwell/folio", number: 313, headRefName: "abc-340", headOid: HEAD, isDraft: false, isCrossRepository: true } });
    expect(fork).toMatchObject({ kind: "repair", cause: "fork" });
  });

  it("works on a draft only in an existing checkout", () => {
    const draft = { prUrl: PR_URL, repo: "inkwell/folio", number: 313, headRefName: "abc-340", headOid: HEAD, isDraft: true, isCrossRepository: false };
    expect(select({ pr: draft })).toEqual({ kind: "wait", cause: "draft", reason: "no checkout for a draft", ref: null });
    expect(withLegacy({ pr: draft })).toMatchObject({ kind: "reuse", checkout: { path: WORKTREE } });
  });

  it("hands off at 70% context to a new thread in the same checkout", () => {
    expect(withLegacy({ threads: [thread(legacyThread, WORKTREE, { contextUsed: 0.69 })] })).toMatchObject({ kind: "reuse", threadId: legacyThread });
    const handoff = withLegacy({ threads: [thread(legacyThread, WORKTREE, { contextUsed: 0.7 })] });
    expect(handoff).toMatchObject({ kind: "spawn", checkout: { path: WORKTREE }, reason: `context 70% full in ${legacyThread}`, references: [legacyThread] });
  });

  it("ranks threads in the checkout: our last worker, legacy workers, origin, direct links, then the most recent", () => {
    const own = { id: "A-1", status: "completed" as const, threadId: "thr_v2", path: null, workspace: null };
    const all = [thread("thr_recent", WORKTREE, { updatedAt: 9 }), thread("thr_linked", WORKTREE), thread("thr_origin", WORKTREE), thread(legacyThread, WORKTREE), thread("thr_v2", WORKTREE)];
    const pick = (threads: ResourceThread[]) => { const result = withLegacy({ attempt: own, origin: "thr_origin", linked: ["thr_linked"], threads }); return result.kind === "reuse" ? result.threadId : result.kind; };
    expect([5, 4, 3, 2, 1].map((count) => pick(all.slice(0, count)))).toEqual(["thr_v2", legacyThread, "thr_origin", "thr_linked", "thr_recent"]);
  });

  it("gives every new thread the origin and legacy threads by reference, with the ticket, never a transcript", () => {
    const result = withLegacy({ origin: "thr_origin", threads: [thread(legacyThread, WORKTREE, { contextUsed: 0.9 })] });
    if (result.kind !== "spawn") throw new Error(result.kind);
    const order = buildWorkOrder({ attemptId: "A-2", revision: 1,
      facts: { prUrl: PR_URL, repo: "inkwell/folio", number: 313, title: "ABC-340 Keep shelf order on reload", headRefName: "abc-340", baseRefName: "main",
        headOid: HEAD, baseOid: "b".repeat(40), approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] } },
      checkout: { path: result.checkout.path, kind: result.checkout.kind }, recipes: ["address_review_feedback"], granted: DEFAULT_EFFECTS, parentMerged: false,
      tickets: [{ id: "ABC-340", title: "Keep shelf order on reload", url: "https://linear.app/inkwell/issue/ABC-340" }],
      criteria: [], threads: result.references, answers: [], direction: null });
    expect(order.text).toContain(`@thread:thr_origin @thread:${legacyThread}`);
    expect(order.text).toContain("ABC-340");
  });

  it("never retitles, reparents, or starts a thread itself: selection only reads", () => {
    const source = readFileSync(new URL("./effort-resources.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bsdk\b|threads\.(update|spawn|send)|parentThreadId|\btitle\b/u);
  });
});
