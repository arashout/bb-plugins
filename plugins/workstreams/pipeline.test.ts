import { describe, expect, it } from "vitest";
import { prSchema, type Pr } from "./contract.js";
import type { Row } from "./inbox-rows.js";
import type { BacklogEntry } from "./pr-backlog.js";
import { activityFor, blockerFor, orderPipelineCards, pipelineBulkCards, pipelineCards, pipelineColumns, pipelineEfforts, pipelineStackGraph, primaryPipelineAction, stageFor, togglePipelineSelection } from "./pipeline.js";
import { reconcileAdvanceSelection, selectVisibleOpen } from "./bulk-advance-selection.js";
import type { Lifecycle } from "./workstreams.js";

const now = Date.parse("2026-09-25T00:00:00Z");
function pr(number: number, patch: Partial<Pr> = {}): Pr {
  return prSchema.parse({ number, state: "OPEN", isDraft: false, reviewDecision: "APPROVED", checkConclusions: ["SUCCESS"],
    url: `https://github.com/inkwell/catalog/pull/${number}`, title: `Improve catalog ${number}`, mergeable: "MERGEABLE",
    baseRefName: "main", headRefName: `book-${number}`, latestReviewStates: ["APPROVED"], unresolvedReviewThreads: 0,
    mergeStateStatus: "CLEAN", createdAt: "2026-09-01T00:00:00Z",
    approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] }, approvalFeedbackVerified: true, ...patch });
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

  it("raises an old prerequisite and keeps a branching stack together before unrelated recent work", () => {
    const parent = pr(101, { headRefName: "foundation", updatedAt: "2026-09-20T00:00:00Z" });
    const child = pr(102, { baseRefName: "foundation", headRefName: "followup", updatedAt: "2026-09-24T00:00:00Z" });
    const grandchild = pr(103, { baseRefName: "followup", updatedAt: "2026-09-22T00:00:00Z" });
    const sibling = pr(104, { baseRefName: "foundation", updatedAt: "2026-09-23T00:00:00Z" });
    const unrelated = pr(105, { updatedAt: "2026-09-25T00:00:00Z" });
    const cards = pipelineCards([entry(unrelated), entry(grandchild), entry(sibling), entry(child), entry(parent)], [], now);
    expect(cards.map((card) => card.pr?.number)).toEqual([101, 102, 103, 104, 105]);
    const graph = pipelineStackGraph(cards);
    expect(graph.parentByChild.get(cards[2]!.key)).toBe(cards[1]!.key);
    expect(pipelineColumns([...cards].reverse()).find((column) => column.stage === "ready")?.cards.map((card) => card.pr?.number)).toEqual([101, 102, 103, 104, 105]);
  });

  it("keeps cross-stage and cross-effort dependencies in their own columns and lanes", () => {
    const parent = pr(106, { headRefName: "foundation", isDraft: true, updatedAt: "2026-09-20T00:00:00Z" });
    const child = pr(107, { baseRefName: "foundation", updatedAt: "2026-09-24T00:00:00Z" });
    const unrelated = pr(108, { isDraft: true, updatedAt: "2026-09-25T00:00:00Z" });
    const cards = pipelineCards([entry(child, { effortKey: "effort:other" }), entry(unrelated), entry(parent, { effortKey: "effort:base" })], [], now);
    const graph = pipelineStackGraph(cards);
    expect(graph.parentByChild.get(cards.find((card) => card.pr?.number === 107)!.key)).toBe(cards.find((card) => card.pr?.number === 106)!.key);
    expect(cards.filter((card) => card.stage === "build").map((card) => card.pr?.number)).toEqual([106, 108]);
    expect(orderPipelineCards(cards.filter((card) => card.effortKey !== "effort:other"), graph).map((card) => card.pr?.number)).toEqual([108, 106]);
    expect(orderPipelineCards(cards.filter((card) => card.pr?.number !== 106), graph).map((card) => card.pr?.number)).toEqual([108, 107]);
  });

  it("keeps holds at the bottom and never promotes a parent solely for a held child", () => {
    const parent = pr(109, { headRefName: "foundation", updatedAt: "2026-09-20T00:00:00Z" });
    const child = pr(110, { baseRefName: "foundation", updatedAt: "2026-09-25T00:00:00Z" });
    const unrelated = pr(111, { updatedAt: "2026-09-24T00:00:00Z" });
    const hold = { reason: "Waiting for a decision", heldAt: now };
    const cards = pipelineCards([entry(parent), entry(child), entry(unrelated)], [], now, { holds: { [child.url]: hold } });
    expect(cards.map((card) => card.pr?.number)).toEqual([111, 109, 110]);
    const bothHeld = pipelineCards([entry(parent), entry(child), entry(unrelated)], [], now, { holds: { [parent.url]: hold, [child.url]: { ...hold } } });
    expect(bothHeld.map((card) => card.pr?.number)).toEqual([111, 109, 110]);
    expect(pipelineStackGraph(bothHeld).parentByChild.get(bothHeld[2]!.key)).toBe(bothHeld[1]!.key);
  });

  it("falls back to recency for missing, merged, cross-repository, and cyclic parents", () => {
    const a = pr(112, { baseRefName: "b", headRefName: "a", updatedAt: "2026-09-20T00:00:00Z" });
    const b = pr(113, { baseRefName: "a", headRefName: "b", updatedAt: "2026-09-21T00:00:00Z" });
    const missing = pr(114, { baseRefName: "absent", updatedAt: "2026-09-22T00:00:00Z" });
    const merged = pr(115, { state: "MERGED", headRefName: "merged-base" });
    const onMerged = pr(116, { baseRefName: "merged-base", updatedAt: "2026-09-23T00:00:00Z" });
    const otherRepo = pr(112, { url: "https://github.com/other/catalog/pull/112", headRefName: "other" });
    const cards = pipelineCards([entry(a), entry(b), entry(missing), entry(onMerged), entry(otherRepo, { repo: "other/catalog" })], [local(merged)], now);
    const graph = pipelineStackGraph(cards);
    expect([...graph.parentByChild]).toEqual([]);
    expect(cards.filter((card) => card.stage === "ready").map((card) => card.pr?.number)).toEqual([116, 114, 113, 112, 112]);
  });

  it("does not match a checkout stack parent by PR number in another repository", () => {
    const child = pr(119, { url: "https://github.com/other/catalog/pull/119" });
    const localChild = local(child, { repo: "other/catalog", unit: { ...local(child).unit,
      stack: { id: "other/catalog#120", position: 2, size: 2, blockedBelow: 120 } } });
    const first = pipelineCards([entry(pr(120))], [localChild], now);
    expect(pipelineStackGraph(first).parentByChild.size).toBe(0);
    const otherParent = pr(120, { url: "https://github.com/other/catalog/pull/120" });
    const both = pipelineCards([entry(pr(120)), entry(otherParent, { repo: "other/catalog" })], [localChild], now);
    const graph = pipelineStackGraph(both);
    expect(graph.parentByChild.get(both.find((card) => card.pr?.url === child.url)!.key)).toBe(both.find((card) => card.pr?.url === otherParent.url)!.key);
  });

  it("uses parent-first stack order for bulk Advance while preserving eligibility", () => {
    const parent = pr(117, { headRefName: "foundation", checkConclusions: ["FAILURE"], updatedAt: "2026-09-20T00:00:00Z" });
    const child = pr(118, { baseRefName: "foundation", checkConclusions: ["FAILURE"], updatedAt: "2026-09-25T00:00:00Z" });
    const cards = pipelineCards([entry(child), entry(parent)], [], now);
    expect(pipelineBulkCards(cards, "feedback").map((card) => card.pr?.number)).toEqual([117, 118]);
  });

  it("holds keep their stage, hide agent activity, and leave bulk selection", () => {
    const held = pr(4, { unresolvedReviewThreads: 2 });
    const key = held.url;
    const cards = pipelineCards([entry(held)], [], now, { holds: { [key]: { reason: "Waiting for copy review", heldAt: now } } });
    expect(cards[0]).toMatchObject({ stage: "feedback", blocker: { label: "On hold" }, activity: { state: "none" }, action: { kind: "release" }, nextStep: "Release the hold when work can resume." });
    expect(pipelineColumns(cards).find((column) => column.stage === "feedback")?.bulkCount).toBe(0);
  });

  it("keeps real waits explicit while offering a fresh Advance preview", () => {
    expect(pipelineCards([entry(pr(5), { stale: true })], [], now)[0]).toMatchObject({ stage: "review", action: { kind: "advance" }, nextStep: "Advance to refresh live PR status." });
    const pending = pipelineCards([entry(pr(6, { checkConclusions: ["WAITING"] }))], [], now)[0]!;
    expect(pending.blocker.label).toBe("Checks pending");
    expect(pending).toMatchObject({ action: { kind: "advance" }, nextStep: "Wait for checks to finish; Advance can recheck status." });
    const rereview = pipelineCards([entry(pr(7, { reviewDecision: "CHANGES_REQUESTED", reviewFollowupPosted: true, reviewRequests: ["reviewer"] }))], [], now)[0]!;
    expect(rereview).toMatchObject({ stage: "review", blocker: { label: "Awaiting re-review" }, action: { kind: "advance" }, nextStep: "Wait for the reviewer to respond to the follow-up." });
    const noReviewer = pipelineCards([entry(pr(19, { reviewDecision: "REVIEW_REQUIRED", reviewRequests: [] }))], [], now)[0]!;
    expect(noReviewer).toMatchObject({ blocker: { label: "No reviewer" }, action: { kind: "open-pr", label: "Choose reviewer" }, nextStep: "Choose a reviewer on GitHub; Advance can recheck other gates." });
    const review = pipelineCards([entry(pr(20, { reviewDecision: "REVIEW_REQUIRED", reviewRequests: ["reviewer"] }))], [], now)[0]!;
    expect(review).toMatchObject({ blocker: { label: "Awaiting review" }, action: { kind: "nudge" }, nextStep: "Nudge the requested reviewer or wait for review." });
  });

  it("counts all open, unheld Feedback PRs for preview, including unapproved feedback", () => {
    const cards = pipelineCards([entry(pr(8, { unresolvedReviewThreads: 2 })), entry(pr(9, { reviewDecision: "CHANGES_REQUESTED" }))], [], now);
    expect(cards.map((card) => card.action?.kind)).toEqual(["advance", "advance"]);
    expect(pipelineColumns(cards).find((column) => column.stage === "feedback")?.bulkCount).toBe(2);
    expect(pipelineBulkCards(cards, "feedback").map((card) => card.pr?.number)).toEqual([8, 9]);
  });

  it("routes unapproved feedback and failing CI through Advance preview", () => {
    const unapproved = pipelineCards([entry(pr(90, { reviewDecision: "CHANGES_REQUESTED" }))], [], now)[0]!;
    expect(unapproved).toMatchObject({ stage: "feedback", action: { kind: "advance" }, nextStep: "Advance to address review feedback." });
    const ciOnly = pipelineCards([entry(pr(91, { checkConclusions: ["TIMED_OUT"] }))], [], now)[0]!;
    expect(ciOnly).toMatchObject({ stage: "feedback", blocker: { label: "CI failing" }, action: { kind: "advance" }, nextStep: "Advance to investigate failing checks." });
    expect(pipelineBulkCards([unapproved, ciOnly], "feedback").map((card) => card.pr?.number)).toEqual([90, 91]);
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
    expect(cards.find((card) => card.pr?.number === 10)).toMatchObject({ effortKey: "cohort:INK-1", effortName: "Catalog cohort" });
    expect(pipelineEfforts(cards).map((effort) => effort.key)).toEqual(["cohort:INK-1", "ticket:INK-1"]);
    expect(pipelineCards([entry(pr(12), { effortKey: "cohort:INK-1", effortName: "Catalog cohort" })], [], now)[0]).toMatchObject({ effortKey: "cohort:INK-1" });
  });

  it("joins copied PR URLs across inventory and checkouts", () => {
    const url = pr(24).url;
    const checkout = local(pr(24, { url: `${url}#discussion` }));
    const cards = pipelineCards([entry(pr(24, { url: `${url}?tab=files` }), { effortKey: "effort:folio", effortName: "Folio review" })],
      [checkout, local(pr(24, { url: url.toUpperCase() + "/" }), { key: "/work/clone" })], now);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ key: url, effortKey: "effort:folio", local: { key: checkout.key } });
  });

  it("keeps stale drafts and unverified local work in Build, and uses PR age only for PRs", () => {
    const draft = pipelineCards([entry(pr(15, { isDraft: true, checkConclusions: ["FAILURE"] }), { stale: true })], [], now)[0]!;
    expect(draft).toMatchObject({ stage: "build", action: { kind: "advance" }, nextStep: "Advance to refresh live PR status." });
    const freshDraft = pipelineCards([entry(pr(18, { isDraft: true }))], [], now)[0]!;
    expect(freshDraft).toMatchObject({ stage: "build", blocker: { label: "Draft" }, action: { kind: "advance" }, nextStep: "Finish draft work; Advance checks for repairable blockers." });
    for (const mergeStateStatus of ["BLOCKED", "UNKNOWN"] as const) {
      const cleanDraft = pipelineCards([entry(pr(27, { isDraft: true, mergeStateStatus }))], [], now)[0]!;
      expect(cleanDraft).toMatchObject({ stage: "build", blocker: { label: "Draft" }, nextStep: "Finish draft work; Advance checks for repairable blockers." });
    }
    const draftFeedback = pipelineCards([entry(pr(25, { isDraft: true, reviewDecision: "CHANGES_REQUESTED" }))], [], now)[0]!;
    expect(draftFeedback).toMatchObject({ stage: "build", blocker: { label: "Changes requested" }, nextStep: "Advance to address review feedback." });
    const draftBehind = pipelineCards([entry(pr(26, { isDraft: true, mergeStateStatus: "BEHIND" }))], [], now)[0]!;
    expect(draftBehind).toMatchObject({ stage: "build", blocker: { label: "Branch behind" }, nextStep: "Advance to update the branch." });
    const noPr = local(null, { unit: { ...local(null).unit, lifecycle: "unverified", lastCommitAt: "2026-09-10T00:00:00Z" } });
    expect(pipelineCards([], [noPr], now)[0]).toMatchObject({ stage: "build", ageSince: Date.parse("2026-09-10T00:00:00Z") });
    expect(pipelineCards([entry(pr(16, { createdAt: null }))], [], now)[0]?.ageSince).toBeNull();
  });

  it("puts held cards below unheld cards in a stage, then sorts each group by recent updates", () => {
    const oldFailure = pr(30, { createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z", checkConclusions: ["FAILURE"] });
    const newHeld = pr(31, { createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-24T00:00:00Z", unresolvedReviewThreads: 2 });
    const oldHeld = pr(38, { updatedAt: "2026-09-22T00:00:00Z", unresolvedReviewThreads: 2 });
    const holds = Object.fromEntries([newHeld, oldHeld].map((item) => [item.url, { reason: "Waiting for copy review", heldAt: now }]));
    const cards = pipelineCards([entry(oldFailure), entry(newHeld), entry(oldHeld)], [], now, { holds });
    expect(cards.map((card) => card.pr?.number)).toEqual([30, 31, 38]);
    expect(cards.map((card) => card.stage)).toEqual(["feedback", "feedback", "feedback"]);
    expect(cards[1]?.ageSince).toBe(Date.parse("2026-09-01T00:00:00Z"));
    expect(pipelineColumns([...cards].reverse()).find((column) => column.stage === "feedback")?.cards.map((card) => card.pr?.number)).toEqual([30, 31, 38]);
    expect(pipelineBulkCards(cards, "feedback").map((card) => card.pr?.number)).toEqual([30]);
  });

  it("falls back through valid PR dates, then places undated cards last by key", () => {
    const cards = pipelineCards([
      entry(pr(32, { updatedAt: "unreadable", createdAt: "2026-09-22T00:00:00Z" })),
      entry(pr(33, { updatedAt: null, createdAt: "2026-09-23T00:00:00Z" })),
      entry(pr(35, { updatedAt: "unreadable", createdAt: "unreadable" })),
      entry(pr(34, { updatedAt: null, createdAt: null })),
    ], [], now);
    expect(cards.map((card) => card.pr?.number)).toEqual([33, 32, 34, 35]);
  });

  it("uses checkout commits for work without a PR and merge time for history cards", () => {
    const oldCheckout = local(null, { key: "/work/a", unit: { ...local(null).unit, lastCommitAt: "2026-09-20T00:00:00Z" } });
    const newCheckout = local(null, { key: "/work/b", unit: { ...local(null).unit, lastCommitAt: "2026-09-24T00:00:00Z" } });
    const oldMerge = local(pr(36, { state: "MERGED", mergedAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-25T00:00:00Z" }));
    const newMerge = local(pr(37, { state: "MERGED", mergedAt: "2026-09-24T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z" }));
    const cards = pipelineCards([], [oldCheckout, newCheckout, oldMerge, newMerge], now);
    expect(cards.map((card) => card.key)).toEqual(["/work/b", "/work/a", newMerge.unit.pr!.url, oldMerge.unit.pr!.url]);
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
    expect(pipelineCards([], [row], now)[0]).toMatchObject({ stage: "build", activity: { state: "working", threadId: "author-2" }, action: { kind: "open-thread" }, nextStep: "Follow the running agent thread." });
    const merged = local(pr(21, { state: "MERGED" }), { cluster: row.cluster });
    expect(pipelineCards([], [merged], now)[0]).toMatchObject({ stage: "merged", activity: { state: "none" } });
  });
});

describe("explicit Advance selection", () => {
  const empty = { urls: [], removed: 0 };
  it("keeps chosen PRs through search, adds only visible PRs on request, and removes held or closed PRs", () => {
    const [draft, review, feedback] = pipelineCards([
      entry(pr(51, { isDraft: true })),
      entry(pr(52, { reviewDecision: "REVIEW_REQUIRED", reviewRequests: ["reviewer"] })),
      entry(pr(53, { checkConclusions: ["FAILURE"] })),
    ], [], now).sort((a, b) => a.pr!.number - b.pr!.number);
    const chosen = togglePipelineSelection(empty, draft!);
    const allPrs = [draft!, review!, feedback!].map((card) => card.pr!);
    expect(reconcileAdvanceSelection(chosen, allPrs)).toBe(chosen);
    expect(reconcileAdvanceSelection(chosen, allPrs).urls).toEqual([draft!.pr!.url]);
    const visibleOnly = selectVisibleOpen([], [feedback!.pr!]);
    expect(visibleOnly).toEqual([feedback!.pr!.url]);
    const crossStage = { ...chosen, urls: selectVisibleOpen(chosen.urls, [review!.pr!, feedback!.pr!]) };
    expect(crossStage.urls).toEqual([draft!.pr!.url, review!.pr!.url, feedback!.pr!.url]);
    const held = { ...review!, hold: { reason: "Waiting", heldAt: now } };
    const closed = { ...feedback!, pr: pr(53, { state: "CLOSED" }) };
    expect(reconcileAdvanceSelection(crossStage, [draft!.pr!, held.pr!, closed.pr!], { [held.pr!.url]: held.hold })).toEqual({ urls: [draft!.pr!.url], removed: 2 });
  });

  it("includes an active PR for preview but excludes holds from explicit selection", () => {
    const active = pipelineCards([entry(pr(54, { isDraft: true }))], [local(pr(54, { isDraft: true }), { cluster: { units: [{ path: "/work/catalog-54" }], threads: [{ id: "author-54", title: "Write catalog copy", active: true, tier: "started" }] } as Row["cluster"] })], now)[0]!;
    expect(active.activity.state).toBe("working");
    expect(selectVisibleOpen([], [active.pr!])).toEqual([active.pr!.url]);
    expect(togglePipelineSelection(empty, { ...active, hold: { reason: "Waiting", heldAt: now } }).urls).toEqual([]);
  });
});
