import { describe, expect, it } from "vitest";
import { prSchema, type Pr } from "./contract.js";
import type { Row } from "./inbox-rows.js";
import type { BacklogEntry } from "./pr-backlog.js";
import { activityFor, blockerFor, pipelineBulkCards, pipelineCards, pipelineColumns, pipelineEfforts, primaryPipelineAction, stageFor } from "./pipeline.js";
import type { Lifecycle } from "./workstreams.js";

const now = Date.parse("2026-09-25T00:00:00Z");
function pr(number: number, patch: Partial<Pr> = {}): Pr {
  return prSchema.parse({ number, state: "OPEN", isDraft: false, reviewDecision: "APPROVED", checkConclusions: ["SUCCESS"],
    url: `https://github.com/inkwell/catalog/pull/${number}`, title: `Improve catalog ${number}`, mergeable: "MERGEABLE",
    baseRefName: "main", headRefName: `book-${number}`, latestReviewStates: ["APPROVED"], unresolvedReviewThreads: 0,
    mergeStateStatus: "CLEAN", createdAt: "2026-09-01T00:00:00Z", ...patch });
}
const entry = (value: Pr, extra: Partial<BacklogEntry> = {}): BacklogEntry => ({ repo: "inkwell/catalog", pr: value, stale: false, ...extra });
function local(value: Pr | null, patch: Partial<Row> = {}): Row {
  return { key: `/work/catalog-${value?.number ?? "next"}`, repo: "inkwell/catalog", title: value?.title ?? "Next catalog feature",
    effortKey: "ticket:INK-1", effort: "Catalog improvements", age: { since: now - 31 * 86_400_000, basis: "state" },
    unit: { path: `/work/catalog-${value?.number ?? "next"}`, pr: value, lifecycle: value?.isDraft ? "in-progress" : value?.state === "MERGED" ? "merged" : "up-next", stack: null, ticket: "INK-1" },
    cluster: { threads: [], units: [{ path: `/work/catalog-${value?.number ?? "next"}` }] }, section: "in-flight", verb: "In progress", action: null, run: null, ...patch } as Row;
}

describe("pipeline position and gates", () => {
  it("maps every lifecycle, while drafts stay in Build even with failed CI", () => {
    const cases: [Lifecycle, string][] = [
      ["active", "build"], ["in-progress", "build"], ["up-next", "build"],
      ["awaiting-review", "review"], ["awaiting-rereview", "review"], ["unverified", "review"],
      ["blocked", "feedback"], ["awaiting-followup", "feedback"], ["approved-with-comments", "feedback"], ["approved-with-note", "feedback"],
      ["awaiting-merge", "ready"], ["merged", "merged"], ["closed", "merged"], ["shipped", "released"],
    ];
    for (const [lifecycle, stage] of cases) expect(stageFor(lifecycle, pr(1))).toBe(stage);
    expect(stageFor("blocked", pr(1, { isDraft: true, checkConclusions: ["FAILURE"] }))).toBe("build");
    expect(stageFor("awaiting-merge", pr(1, { mergeStateStatus: "DIRTY" }))).toBe("feedback");
    expect(stageFor("awaiting-merge", pr(1, { mergeStateStatus: "BEHIND" }))).toBe("feedback");
  });

  it("keeps a stack child in Ready but opens the parent before merging", () => {
    const parent = pr(2, { headRefName: "foundation" });
    const child = pr(3, { baseRefName: "foundation" });
    const cards = pipelineCards([entry(child), entry(parent)], [], now);
    const top = cards.find((card) => card.pr?.number === 3)!;
    expect(top).toMatchObject({ stage: "ready", blocker: { label: "Behind #2" }, action: { kind: "open-parent", behind: 2 } });
    expect(pipelineColumns(cards).find((column) => column.stage === "ready")?.bulkCount).toBe(1);
  });

  it("holds keep their stage, hide agent activity, and leave bulk selection", () => {
    const held = pr(4, { unresolvedReviewThreads: 2 });
    const key = held.url;
    const cards = pipelineCards([entry(held)], [], now, { holds: { [key]: { reason: "Waiting for copy review", heldAt: now } } });
    expect(cards[0]).toMatchObject({ stage: "feedback", blocker: { label: "On hold" }, activity: { state: "none" }, action: { kind: "release" } });
    expect(pipelineColumns(cards).find((column) => column.stage === "feedback")?.bulkCount).toBe(0);
  });

  it("gives stale and pending PRs no merge action, and never nudges after follow-up", () => {
    expect(pipelineCards([entry(pr(5), { stale: true })], [], now)[0]).toMatchObject({ stage: "review", action: null });
    const pending = pipelineCards([entry(pr(6, { checkConclusions: ["WAITING"] }))], [], now)[0]!;
    expect(pending.blocker.label).toBe("Checks pending");
    expect(pending.action).toBeNull();
    const rereview = pipelineCards([entry(pr(7, { reviewDecision: "CHANGES_REQUESTED", reviewFollowupPosted: true, reviewRequests: ["reviewer"] }))], [], now)[0]!;
    expect(rereview).toMatchObject({ stage: "review", blocker: { label: "Awaiting re-review" }, action: null });
  });

  it("counts only approved, unheld Feedback PRs for Advance", () => {
    const cards = pipelineCards([entry(pr(8, { unresolvedReviewThreads: 2 })), entry(pr(9, { reviewDecision: "CHANGES_REQUESTED" }))], [], now);
    expect(cards.map((card) => card.action?.kind)).toEqual(["advance", "open-pr"]);
    expect(pipelineColumns(cards).find((column) => column.stage === "feedback")?.bulkCount).toBe(1);
    expect(pipelineBulkCards(cards, "feedback").map((card) => card.pr?.number)).toEqual([8]);
  });

  it("opens remote unapproved feedback and keeps approved CI in the batch contract", () => {
    const unapproved = pipelineCards([entry(pr(90, { reviewDecision: "CHANGES_REQUESTED" }))], [], now)[0]!;
    expect(unapproved).toMatchObject({ stage: "feedback", action: { kind: "open-pr", label: "Open PR" } });
    const ciOnly = pipelineCards([entry(pr(91, { checkConclusions: ["TIMED_OUT"] }))], [], now)[0]!;
    expect(ciOnly).toMatchObject({ stage: "feedback", blocker: { label: "CI failing" }, action: { kind: "advance" } });
    expect(pipelineBulkCards([unapproved, ciOnly], "feedback").map((card) => card.pr?.number)).toEqual([91]);
    const localCi = pipelineCards([entry(pr(94, { checkConclusions: ["TIMED_OUT"], reviewDecision: null }))], [local(pr(94, { checkConclusions: ["TIMED_OUT"], reviewDecision: null }))], now)[0]!;
    expect(localCi).toMatchObject({ stage: "feedback", blocker: { label: "CI failing" }, action: { kind: "advance" } });
  });

  it("includes an approved parent-blocked Feedback PR in batch Advance even when its card opens the parent", () => {
    const parent = pr(92, { headRefName: "foundation" });
    const child = pr(93, { baseRefName: "foundation", checkConclusions: ["FAILURE"] });
    const cards = pipelineCards([entry(child), entry(parent)], [], now);
    expect(cards.find((card) => card.pr?.number === 93)).toMatchObject({ stage: "feedback", action: { kind: "open-parent" } });
    expect(pipelineBulkCards(cards, "feedback").map((card) => card.pr?.number)).toEqual([93]);
  });

  it("deduplicates inventory, cloned checkouts, and checkout-only PRs; retains effort keys", () => {
    const shared = pr(10);
    const checkoutOnly = pr(11, { isDraft: true });
    const cards = pipelineCards([entry(shared, { effortKey: "cohort:INK-1", effortName: "Catalog cohort" }), entry(shared)],
      [local(shared), local(shared, { key: "/work/clone" }), local(checkoutOnly), local(checkoutOnly, { key: "/work/clone2" }), local(null)], now);
    expect(cards).toHaveLength(3);
    expect(cards.find((card) => card.pr?.number === 10)?.local).not.toBeNull();
    expect(cards.find((card) => card.pr?.number === 10)?.repo).toBe("inkwell/catalog");
    expect(cards.find((card) => card.pr?.number === 11)?.stage).toBe("build");
    expect(pipelineEfforts(cards).map((effort) => effort.key)).toEqual(["ticket:INK-1"]);
    expect(pipelineCards([entry(pr(12), { effortKey: "cohort:INK-1", effortName: "Catalog cohort" })], [], now)[0]).toMatchObject({ effortKey: "cohort:INK-1" });
  });

  it("keeps stale drafts and unverified local work in Build, and uses PR age only for PRs", () => {
    const draft = pipelineCards([entry(pr(15, { isDraft: true, checkConclusions: ["FAILURE"] }), { stale: true })], [], now)[0]!;
    expect(draft.stage).toBe("build");
    const noPr = local(null, { unit: { ...local(null).unit, lifecycle: "unverified", lastCommitAt: "2026-09-10T00:00:00Z" } });
    expect(pipelineCards([], [noPr], now)[0]).toMatchObject({ stage: "build", ageSince: Date.parse("2026-09-10T00:00:00Z") });
    expect(pipelineCards([entry(pr(16, { createdAt: null }))], [], now)[0]?.ageSince).toBeNull();
  });

  it("uses current ready facts over an old failed Advance attempt", () => {
    const current = pr(17);
    const sources = { batches: [{ id: "batch", createdAt: now - 1000, cancelled: false, jobs: [{ id: "job", prUrl: current.url,
      status: "needs-attention", detail: "Earlier attempt failed", threadId: "thread-1", updatedAt: now - 1000 }] }] } as unknown as Parameters<typeof pipelineCards>[3];
    expect(pipelineCards([entry(current)], [], now, sources)[0]).toMatchObject({ stage: "ready", action: { kind: "merge" }, activity: { state: "none" } });
  });

  it("keeps a usable repository when cached PR URL is malformed", () => {
    const card = pipelineCards([entry(pr(23, { url: "bad-url" }))], [], now)[0]!;
    expect(card.repo).toBe("inkwell/catalog");
  });

  it("keeps release evidence from any merged checkout clone", () => {
    const merged = pr(22, { state: "MERGED" });
    const plain = local(merged, { key: "/work/aaa-plain", unit: { ...local(merged).unit, lifecycle: "merged" } });
    const tagged = local(merged, { key: "/work/zzz-tagged", unit: { ...local(merged).unit, lifecycle: "shipped" } });
    expect(pipelineCards([], [plain, tagged], now)).toMatchObject([{ stage: "released", local: { key: "/work/zzz-tagged" } }]);
  });

  it("shows release-tagged and merged checkouts as separate columns", () => {
    const merged = pr(13, { state: "MERGED" });
    const cards = pipelineCards([], [local(merged, { unit: { ...local(merged).unit, lifecycle: "merged" } }),
      local(pr(14, { state: "MERGED" }), { unit: { ...local(pr(14)).unit, lifecycle: "shipped" } })], now);
    expect(cards.map((card) => card.stage)).toEqual(["merged", "released"]);
  });
});

describe("card activity", () => {
  it("uses the latest active advance job and routes stuck work to Fix", () => {
    const source = { batches: [{ id: "batch", createdAt: now, cancelled: false, jobs: [{ id: "job", prUrl: pr(1).url,
      status: "needs-attention", detail: "Agent needs direction", threadId: "thread-1", updatedAt: now }] }] } as unknown as Parameters<typeof activityFor>[2];
    const activity = activityFor(pr(1).url, null, source);
    expect(activity).toMatchObject({ state: "needs-you", source: "advance", threadId: "thread-1" });
    expect(primaryPipelineAction("feedback", blockerFor(pr(1), "feedback", null), activity, null, null)).toMatchObject({ kind: "fix" });
  });

  it("prefers an active run over a later completed job", () => {
    const url = pr(20).url;
    const sources = { batches: [{ id: "batch", createdAt: now, cancelled: false, jobs: [{ id: "job", prUrl: url,
      status: "ready", detail: "Old work complete", threadId: "thread-old", updatedAt: now }] }],
      runs: [{ kind: "agent", path: "/work/catalog-20", prUrl: url, status: "running", startedAt: now - 1000,
        finishedAt: null, result: null, error: null, action: "address-review", threadId: "thread-live" }] } as unknown as Parameters<typeof activityFor>[2];
    expect(activityFor(url, "/work/catalog-20", sources)).toMatchObject({ state: "working", threadId: "thread-live" });
  });

  it("uses a linked active author thread to show Build work and open it", () => {
    const row = local(pr(2, { isDraft: true }), { cluster: { units: [{ path: "/work/catalog-2" }], threads: [{ id: "author-2", title: "Write catalog copy", active: true, tier: "started" }] } as Row["cluster"] });
    expect(pipelineCards([], [row], now)[0]).toMatchObject({ stage: "build", activity: { state: "working", threadId: "author-2" }, action: { kind: "open-thread" } });
    const merged = local(pr(21, { state: "MERGED" }), { cluster: row.cluster });
    expect(pipelineCards([], [merged], now)[0]).toMatchObject({ stage: "merged", activity: { state: "none" } });
  });
});
