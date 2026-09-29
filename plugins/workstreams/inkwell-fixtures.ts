// Fictional Inkwell bookstore data. The shapes copy recorded Workstreams state
// (batch sizes, overlaps, statuses, checkouts, and ownership); every name,
// number, path, and thread id is invented.
import { advanceBatchSchema, type AdvanceBatch, type AdvanceJob } from "./bulk-advance.js";
import { prSchema, type Pr, type RawUnit } from "./contract.js";
import type { EffortRoster, RosterRow } from "./effort-roster.js";
import { suggestReviewers } from "./inventory-actions.js";
import { inventoryRow, inventoryView, type InventoryView, type ThreadRef } from "./inventory-view.js";
import { DEFAULT_ATTENTION_THRESHOLDS, prAttention, type StateSince } from "./pr-attention.js";
import { stackParent } from "./pr-backlog.js";
import { GATE_IDS } from "./pr-gates.js";
import type { ResolvedThreadLink } from "./work-context.js";

const HOME = "/Users/reader";
const START = Date.UTC(2026, 8, 26, 12);
const MINUTE = 60_000;

/** The 22 PRs legacy Advance touched, by index. */
const PRS: [repo: string, number: number, title: string][] = [
  ["folio", 311, "OPS-41 Rotate vault audit keys"],
  ["folio", 312, "OPS-42 Record vault access reviews"],
  ["quill", 208, "ABC-310 Show pen names on receipts"],
  ["catalog", 95, "ABC-118 Sort series by publication order"],
  ["catalog", 96, "ABC-120 Link follow-up notes to catalog entries"],
  ["atlas", 401, "ABC-201 Let readers edit shipping addresses"],
  ["atlas", 402, "ABC-202 Show order totals before checkout"],
  ["atlas", 403, "ABC-203 Explain gift card balances"],
  ["atlas", 404, "ABC-204 Keep reading lists after sign-in"],
  ["atlas", 405, "ABC-205 Let readers update their email"],
  ["atlas", 406, "ABC-206 Confirm email changes by link"],
  ["atlas", 407, "ABC-207 Show membership renewal dates"],
  ["atlas", 408, "ABC-208 Offer paperback and hardcover prices"],
  ["atlas", 409, "ABC-209 Explain delivery estimates"],
  ["spine", 150, "ABC-330 Reserve books for store pickup"],
  ["spine", 151, "ABC-331 Notify readers when holds arrive"],
  ["spine", 152, "ABC-332 Expire unclaimed holds"],
  ["spine", 153, "ABC-333 Show pickup hours per store"],
  ["quill", 209, "OPS-43 Log vault token use"],
  ["spine", 154, "ABC-334 Print pickup slips"],
  ["folio", 313, "ABC-340 Keep shelf order on reload"],
  ["folio", 314, "ABC-341 Group shelves by genre"],
];
export const INKWELL_ADVANCE_PR_URLS = PRS.map(([repo, number]) => `https://github.com/inkwell/${repo}/pull/${number}`);

/** Effort ownership of those PRs; the other 15 belong to no effort. */
export const INKWELL_ADVANCE_EFFORTS = {
  "Reader accounts": [9, 10, 11].map((index) => INKWELL_ADVANCE_PR_URLS[index]!),
  "Catalog follow-ups": [4].map((index) => INKWELL_ADVANCE_PR_URLS[index]!),
  "Vault audits": [0, 1, 18].map((index) => INKWELL_ADVANCE_PR_URLS[index]!),
};

const NOT_CONFIRMED = "Requested work was not confirmed. GitHub: ";
const DETAIL = {
  feedback: `${NOT_CONFIRMED}Approval feedback needs code and validation evidence for the current head.`,
  checksNotConfirmed: `${NOT_CONFIRMED}One or more checks failed.`,
  conflicts: `${NOT_CONFIRMED}Resolve conflicts, test, and push the prepared branch.`,
  approvalNotConfirmed: `${NOT_CONFIRMED}Waiting for approval on the current PR.`,
  threads: `${NOT_CONFIRMED}1 unresolved review threads need attention.`,
  approval: "Waiting for approval on the current PR.",
  changes: "Review still requests changes; wait for a new approval after follow-up.",
  evidence: "Approval feedback evidence is missing, incomplete, or stale for the current head and review.",
  parent: "The base branch belongs to another open PR; advance that dependency first.",
  ready: "Approved, review feedback clear, checks passed, and branch ready to merge.",
  blocked: "Worker reported incomplete work or failed validation; inspect its result",
  checks: "One or more checks failed.",
  stale: "PR head, approval, feedback, base, or workspace changed since preview. Preview it again.",
  controller: "Working on branch preparation, failing checks in the repository controller",
  repair: "Repairing this PR in a dedicated follow-up",
};

/** [PR index, status, detail, checkout, has a worker thread, minutes after batch creation it was last updated, earlier attempts] */
type Row = [pr: number, status: AdvanceJob["status"], detail: keyof typeof DETAIL, checkout: "worktree" | "author" | null, thread: boolean, updated: number, previous?: number];
/** [minutes after the first batch, jobs]: 13 single-job batches, one 9-job batch, and one 15-job continuation. */
const BATCHES: [created: number, rows: Row[]][] = [
  [0, [[18, "needs-attention", "feedback", "worktree", false, 1_375, 1]]],
  [1_014, [[2, "needs-attention", "checksNotConfirmed", null, false, 459]]],
  [1_014, [[5, "needs-attention", "conflicts", null, false, 380]]],
  [1_015, [[6, "waiting-review", "approval", null, false, 418]]],
  [1_015, [[7, "needs-attention", "conflicts", null, false, 444]]],
  [1_015, [[17, "waiting-review", "approval", "worktree", true, 359]]],
  [1_016, [[14, "needs-attention", "approvalNotConfirmed", "worktree", true, 359, 2]]],
  [1_016, [[16, "waiting-review", "approval", "author", false, 359]]],
  [1_016, [[19, "waiting-review", "approval", "worktree", true, 449]]],
  [1_018, [[20, "waiting-review", "changes", "worktree", true, 356]]],
  [1_019, [[13, "waiting-review", "approval", null, false, 440]]],
  [1_330, [
    [1, "needs-attention", "evidence", "worktree", true, 44],
    [4, "needs-attention", "parent", "worktree", true, 44],
    [8, "needs-attention", "evidence", "worktree", true, 44],
    [9, "needs-attention", "feedback", "worktree", true, 44],
    // A later recheck bumped this job past its newer continuation job.
    [10, "needs-attention", "parent", "author", false, 132],
    [11, "needs-attention", "feedback", "author", false, 127],
    [12, "needs-attention", "feedback", null, false, 64],
    [15, "ready", "ready", "worktree", true, 44],
    [21, "needs-attention", "parent", "worktree", true, 44],
  ]],
  [1_334, [[3, "waiting-review", "approval", "worktree", false, 104]]],
  [1_350, [[0, "needs-attention", "threads", "worktree", true, 24]]],
  [1_388, [
    [0, "needs-attention", "blocked", "worktree", true, 5],
    [1, "needs-attention", "parent", "worktree", true, 3],
    [2, "needs-attention", "checks", "worktree", true, 86],
    [5, "running", "controller", "worktree", true, 71],
    [6, "waiting-review", "approval", null, false, 71],
    [7, "needs-attention", "blocked", "worktree", true, 71],
    [8, "ready", "ready", "worktree", true, 71],
    [9, "needs-attention", "parent", "worktree", true, 7],
    [10, "needs-attention", "parent", "worktree", true, 69],
    [11, "running", "repair", "worktree", true, 83, 1],
    [12, "needs-attention", "feedback", null, false, 72],
    [13, "waiting-review", "approval", null, false, 72],
    [18, "needs-attention", "stale", null, false, 82],
    [19, "waiting-review", "approval", "worktree", true, 78],
    [20, "waiting-review", "changes", null, false, 0],
  ]],
];

/** Legacy Advance batches, newest first as `advance.list()` returns them. */
export const INKWELL_ADVANCE_BATCHES: AdvanceBatch[] = BATCHES.map(([created, rows], index) => {
  const id = `batch-${String(index + 1).padStart(2, "0")}`;
  const createdAt = START + created * MINUTE;
  return advanceBatchSchema.parse({ id, createdAt, cancelled: false, jobs: rows.map(([pr, status, detail, checkout, thread, updated, previous = 0]) => {
    const [repo, number, title] = PRS[pr]!;
    const jobId = `${id}-job-${pr}`;
    const attemptId = `${jobId}-attempt`;
    // A repair keys its worktree by attempt, not by job.
    const path = checkout === "worktree" ? `${HOME}/.bb/plugins/workstreams/worktrees/${id}/inkwell--${repo}/${previous > 0 ? attemptId : jobId}`
      : checkout === "author" ? `${HOME}/src/${repo}` : null;
    const updatedAt = createdAt + updated * MINUTE;
    return {
      id: jobId, prUrl: INKWELL_ADVANCE_PR_URLS[pr], repo: `inkwell/${repo}`, number, title,
      headOid: (pr + 1).toString(16).padStart(40, "0"), baseOid: "b".repeat(40),
      baseRefName: "main", headRefName: title.split(" ")[0]!.toLowerCase(), needsPreparation: detail === "conflicts", eligible: true,
      detail: DETAIL[detail], workspace: checkout === "author" ? "existing" : "create", status,
      attemptId, dedicated: previous > 0,
      previousAttempts: Array.from({ length: previous }, (_, attempt) => ({ attemptId: `${jobId}-attempt-${attempt}`,
        threadId: `thr_ink_${index + 1}_${pr}_${attempt}`, path, detail: "Worker stopped; inspect its thread before retrying",
        status: "needs-attention", updatedAt: updatedAt - (previous - attempt) * MINUTE })),
      threadId: thread ? `thr_ink_${index + 1}_${pr}` : null, path, checkedHeadOid: null, updatedAt, uncertain: false,
    };
  }) });
}).reverse();

/** [repo, number, title, open, checkout, description] for one roster member. */
type Member = [repo: string, number: number, title: string, state: "OPEN" | "MERGED", checkout: boolean, body?: string];
const REPOS = ["catalog", "folio", "quill", "atlas", "spine"];
const ticketRange = (prefix: string, first: number, count: number) => Array.from({ length: count }, (_, index) => `${prefix}-${first + index}`);
const CATALOG_TICKETS = ticketRange("ABC", 120, 21);
const SHELVING_TICKETS = ticketRange("ABC", 401, 7);
const VAULT_TICKETS = ticketRange("OPS", 41, 10);
/** Catalog: 31 open PRs over 20 of its 21 tickets, one without a checkout; ABC-140 has no PR yet. */
const CATALOG: Member[] = Array.from({ length: 31 }, (_, index) => {
  const ticket = CATALOG_TICKETS[index < 22 ? index >> 1 : index - 11]!;
  return index === 0 ? ["catalog", 96, "ABC-120 Link follow-up notes to catalog entries", "OPEN", true]
    : [REPOS[index % 5]!, 500 + index, `${ticket} Catalog follow-up ${index}`, "OPEN", index !== 30];
});
/** Shelving: 16 open PRs over its 7 tickets with 13 checkouts, plus 7 merged backend PRs that are context only. */
const SHELVING: Member[] = [
  ...Array.from({ length: 16 }, (_, index): Member =>
    [REPOS[index % 5]!, 700 + index, `${SHELVING_TICKETS[index < 6 ? index % 2 : 2 + (index - 6 >> 1)]!} Shelve new arrivals ${index}`, "OPEN", index < 13]),
  ...SHELVING_TICKETS.map((ticket, index): Member => ["spine", 720 + index, `${ticket} Shelving backend ${index}`, "MERGED", true]),
];
/** Vault: 18 open PRs over its 10 tickets with 10 checkouts; six only mention a Catalog ticket in their descriptions. */
const VAULT: Member[] = [
  ["folio", 311, "OPS-41 Rotate vault audit keys", "OPEN", true],
  ["folio", 312, "OPS-42 Record vault access reviews", "OPEN", true],
  ["quill", 209, "OPS-43 Log vault token use", "OPEN", true],
  ...Array.from({ length: 15 }, (_, index): Member => [REPOS[index % 5]!, 800 + index, `${VAULT_TICKETS[index % 10]!} Audit vault access ${index}`, "OPEN", index < 7,
    index >= 9 ? `Found while reviewing https://linear.app/inkwell/issue/${CATALOG_TICKETS[index]}\nRefs: ${CATALOG_TICKETS[index]}` : undefined]),
];
/** An OPS ticket no effort owns yet: a prefix is no standing claim. */
const FUTURE: Member = ["atlas", 610, "OPS-90 Rotate archive keys", "OPEN", false];

const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
function pull([repo, number, title, state, , body]: Member) {
  const [, prefix, id] = /^([A-Z]+)-(\d+)/u.exec(title)!;
  return prSchema.parse({ number, state, isDraft: false, reviewDecision: null, checkConclusions: [], url: url(repo, number), title,
    mergeable: state === "OPEN" ? "MERGEABLE" : "UNKNOWN", baseRefName: "main", headRefName: `${prefix!.toLowerCase()}-${id}-${number}`,
    headRefOid: number.toString(16).padStart(40, "a"), latestReviewStates: [], mergeStateStatus: state === "OPEN" ? "CLEAN" : "UNKNOWN",
    ...(body ? { ticketRefs: { urls: [/issue\/([A-Z]+-\d+)/u.exec(body)![1]!], mentions: [] } } : {}) });
}
const members = [...CATALOG, ...SHELVING, ...VAULT, FUTURE];

/** The acceptance cohorts as fictional board state: saved efforts, scanned checkouts, authored PRs, and Linear titles. */
export const INKWELL_ROSTER = {
  efforts: [
    { name: "Catalog follow-ups", tickets: CATALOG_TICKETS, prUrls: CATALOG.map(([repo, number]) => url(repo, number)) },
    { name: "Shelving entry", tickets: SHELVING_TICKETS, prUrls: SHELVING.filter((member) => member[3] === "OPEN").map(([repo, number]) => url(repo, number)) },
    { name: "Vault audits", tickets: VAULT_TICKETS, prUrls: VAULT.filter((member) => !member[5]).map(([repo, number]) => url(repo, number)) },
  ],
  /** Every Vault PR whose description mentions a Catalog ticket. */
  described: VAULT.filter((member) => member[5]).map(([repo, number]) => url(repo, number)),
  future: url(FUTURE[0], FUTURE[1]),
  units: members.filter((member) => member[4]).map((member): RawUnit => {
    const pr = pull(member);
    return { path: `${HOME}/src/${member[0]}-${member[1]}`, dirName: `${member[0]}-${member[1]}`, repo: member[0], githubRepo: `inkwell/${member[0]}`,
      branch: pr.headRefName, dirty: false, ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", pr, shipped: null, changedPaths: [],
      observed: { status: true, pr: true } };
  }),
  inventory: members.filter((member) => member[3] === "OPEN").map((member) => ({ repo: `inkwell/${member[0]}`, pr: pull(member) })),
  linear: [...CATALOG_TICKETS, ...SHELVING_TICKETS, ...VAULT_TICKETS].map((ticket) => ({ ticket,
    title: `${ticket.startsWith("OPS") ? "Vault audit" : "Bookstore task"} ${ticket.slice(4)}`, url: `https://linear.app/inkwell/issue/${ticket}` })),
};

/**
 * The roster pane's scenario (V2-UI-SPEC §2): "Shelving entry" at 11:30, with instruction revision 4 including 1, 2, and 4-17, leaving 3
 * alone, and 8 held. Two decisions are open (D1 product, D2 mark-ready), launches are paused behind an uncertain launch on 17 (S1), and 9
 * and 16 are verified merge candidates, with 10 and 11 stacked on 9.
 */
export const SHELVING_ROSTER_NOW = Date.UTC(2026, 8, 28, 15, 30);
const AGO = (ms: number) => SHELVING_ROSTER_NOW - ms;
const SECOND = 1_000;
const HOUR = 60 * MINUTE;
const shelf = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
const gates = (failing: string[] = []) => Object.fromEntries(GATE_IDS.map((id) => [id, !failing.includes(id)])) as RosterRow["gates"];
const allowed = { ok: true, why: null };
function shelvingRow(n: number, repo: string, number: number, reviewer: string, title: string, row: Partial<RosterRow>): RosterRow {
  return {
    n, provisional: false, target: shelf(repo, number), repo: `inkwell/${repo}`, number, title, state: "waiting", cause: "observe", label: "", owner: null,
    outsideMembership: false, modifiers: [], hold: null, reviewers: [{ login: reviewer, state: "COMMENTED" }], requested: [], head: number.toString(16).padStart(40, "c"),
    checks: "passed", reviewDecision: null, gates: gates(), observedAt: AGO(MINUTE), failedAt: null, tickets: [{ id: "ABC-401", title: "Shelve new stock", url: "https://linear.app/inkwell/issue/ABC-401" }],
    checkouts: [], legacy: null, wake: null, nextAction: null, work: null, claim: null, stack: null, checkCounts: { done: 9, total: 9, failed: 0 }, stale: false,
    staleAt: AGO(MINUTE) + 10 * MINUTE, membership: "included", membershipReason: null,
    actions: { recheck: allowed, reset: { ...allowed, release: false }, retry: { ok: false, why: `retry ${n} restarts a system issue or a stopped row, and ${n} is neither.` },
      stop: { ok: false, why: `stop ${n} interrupts a running turn, and none of ours is running on ${n}. To keep it from starting, hold ${n}.` } },
    ...row,
  };
}
const worker = (recipe: string, resource: NonNullable<RosterRow["work"]>["resource"]): RosterRow["work"] => ({ executor: "worker", recipes: [recipe], resource, planned: false });
const running = (n: number, threadId: string, since: number): Partial<RosterRow> => ({ claim: { attemptId: `att-${n}`, status: "running", threadId, since },
  actions: { recheck: allowed, reset: { ...allowed, release: false }, retry: { ok: false, why: `retry ${n} restarts a system issue or a stopped row, and ${n} is neither.` }, stop: allowed } });
const productDecision = { state: "decision", cause: "product", owner: "you", nextAction: null } as const;
const lifecycleDecision = { state: "decision", cause: "draft", owner: "you", gates: gates(["not-draft"]) } as const;
const nine = shelf("spine", 212);

const SHELVING_ROWS: RosterRow[] = [
  shelvingRow(1, "folio", 412, "mara-l", "Shelf-slot picker on entry form", { state: "doing", cause: "worker", label: "Addressing 3 review notes", owner: "v2",
    nextAction: ["address_review_feedback"], work: worker("address_review_feedback", { kind: "reuse", threadId: "thr_folio_entry", reason: null }),
    wake: { event: "the worker's thread goes idle, fails, or asks for input", dueAt: AGO(-4 * MINUTE) }, ...running(1, "thr_folio_entry", AGO(3 * MINUTE)) }),
  shelvingRow(2, "quill", 188, "tobyk", "ISBN-13 checksum on entry", { state: "doing", cause: "worker", label: "Fixing the lint:codes check", owner: "v2", observedAt: AGO(25 * SECOND),
    nextAction: ["fix_failing_checks"], work: worker("fix_failing_checks", { kind: "spawn", threadId: "thr_quill_188", reason: "the only quill thread is busy on #185" }),
    ...running(2, "thr_quill_188", AGO(2 * MINUTE)) }),
  shelvingRow(3, "atlas", 301, "juno", "Floor-map shelf coordinates", { state: "not-in-instruction", cause: "review-feedback", label: "Review feedback open", owner: "you",
    reviewers: [{ login: "juno", state: "CHANGES_REQUESTED" }], observedAt: AGO(3 * MINUTE), membership: "excluded", membershipReason: "this instruction only" }),
  shelvingRow(4, "catalog", 903, "hugo-b", "Shelf code normalization", { state: "doing", cause: "verifying", label: "Verifying new head 7f3a2c1", owner: "v2",
    observedAt: AGO(12 * SECOND), nextAction: "observe", work: { executor: "procedure", recipes: [], resource: null, planned: false } }),
  shelvingRow(5, "spine", 214, "priya-l", "Barcode rescan on mismatch", { cause: "ci", label: "Checks running", owner: "ci", checks: "pending", observedAt: AGO(2 * MINUTE),
    checkCounts: { done: 7, total: 9, failed: 0 }, wake: { event: "check results change", dueAt: AGO(-2 * MINUTE) }, gates: gates(["checks-settled"]),
    work: { executor: null, recipes: [], resource: null, planned: false } }),
  shelvingRow(6, "catalog", 907, "ines-v", "Condition grade enum", { cause: "review", label: "Waiting for review from @ines-v", owner: "reviewer", requested: ["ines-v"],
    reviewers: [], observedAt: AGO(52 * MINUTE), stale: true, staleAt: AGO(22 * MINUTE), gates: gates(["approved"]),
    wake: { event: "the review decision, reviews, review requests, or unresolved threads change", dueAt: AGO(-15 * MINUTE) },
    work: { executor: null, recipes: [], resource: null, planned: false } }),
  shelvingRow(7, "folio", 415, "mara-l", "Out-of-print titles at entry", { ...productDecision, label: "Out-of-print ISBNs at entry: allow or block?" }),
  shelvingRow(8, "quill", 191, "tobyk", "Dewey fallback for unlabeled stock", { cause: "hold", label: "On hold: waiting on catalog team copy", owner: "you",
    observedAt: AGO(4 * MINUTE), hold: { reason: "waiting on catalog team copy", heldAt: AGO(2 * 24 * HOUR) }, wake: { event: "the hold is released", dueAt: AGO(-11 * MINUTE) } }),
  shelvingRow(9, "spine", 212, "oriel-k", "Shelf location schema v2", { state: "ready", cause: "merge-candidate", label: "Verified merge candidate", owner: "you",
    reviewDecision: "APPROVED", checkCounts: { done: 12, total: 12, failed: 0 } }),
  shelvingRow(10, "spine", 215, "oriel-k", "Location assign API", { cause: "parent", label: "Prepared on 7be2f0; retargets and reverifies when 9 merges", owner: "parent",
    observedAt: AGO(3 * MINUTE), stack: { parentTarget: nine, parentN: 9 }, gates: gates(["parent-merged"]),
    wake: { event: "the parent merges, closes, or gets a new head", dueAt: AGO(-20 * MINUTE) } }),
  shelvingRow(11, "spine", 217, "oriel-k", "Bulk shelve endpoint", { cause: "parent", label: "Prepared on 0c9d31; retargets and reverifies when 9 merges", owner: "parent",
    observedAt: AGO(3 * MINUTE), stack: { parentTarget: nine, parentN: 9 }, gates: gates(["parent-merged"]),
    wake: { event: "the parent merges, closes, or gets a new head", dueAt: AGO(-20 * MINUTE) } }),
  shelvingRow(12, "quill", 93, "sana-r", "Entry preview badge", { ...productDecision, label: "Waits on D1", observedAt: AGO(2 * MINUTE) }),
  shelvingRow(13, "folio", 418, "mara-l", "Empty-shelf state", { ...lifecycleDecision, label: "Draft; branch and checks settled", observedAt: AGO(2 * MINUTE) }),
  shelvingRow(14, "atlas", 85, "juno", "Shelf capacity warnings", { ...lifecycleDecision, label: "Draft; worker noted a TODO in the threshold", observedAt: AGO(2 * MINUTE) }),
  shelvingRow(15, "catalog", 910, "hugo-b", "Condition photo upload", { ...lifecycleDecision, label: "Draft; branch and checks settled", observedAt: AGO(2 * MINUTE) }),
  shelvingRow(16, "quill", 192, "dee-o", "Entry audit log", { state: "ready", cause: "merge-candidate", label: "Verified merge candidate", owner: "you", reviewDecision: "APPROVED" }),
  shelvingRow(17, "folio", 421, "mara-l", "Series and volume fields", { state: "doing", cause: "launch-uncertain", modifiers: ["recovering"], owner: "v2",
    label: "Launch at 11:27 uncertain; reading BB back by its launch key", observedAt: AGO(40 * SECOND), nextAction: "recover-launch",
    work: worker("fix_failing_checks", { kind: "spawn", threadId: null, reason: "no idle thread in its checkout" }),
    claim: { attemptId: "att-17", status: "uncertain", threadId: "thr_folio_421", since: AGO(3 * MINUTE) },
    actions: { recheck: allowed, reset: { ...allowed, release: true }, retry: { ok: false, why: "Uncertain launch: a retry could start a second writer" },
      stop: { ok: false, why: "stop 17 interrupts a running turn, and none of ours is running on 17. To keep it from starting, hold 17." } } }),
  shelvingRow(18, "catalog", 899, "hugo-b", "Condition grade labels", { state: "done", cause: "merged", label: "Merged", owner: null, observedAt: AGO(32 * MINUTE), staleAt: null }),
  shelvingRow(19, "atlas", 79, "juno", "Shelf id index", { state: "done", cause: "merged", label: "Merged", owner: null, observedAt: AGO(2 * 24 * HOUR), staleAt: null }),
];
const refs = (...ns: number[]) => ns.map((n) => ({ target: SHELVING_ROWS[n - 1]!.target, n }));
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

export const INKWELL_SHELVING_ROSTER: EffortRoster = {
  effort: { id: "eff-shelving", key: "shelving-entry", name: "Shelving entry", goal: "Staff shelve new stock at entry", archivedAt: null, redirectedFrom: null,
    coordinatorThreadId: "thr_shelving_parent" },
  snapshotId: "S-41a7c3e90b2d", execution: { mode: "v2", revision: 1 }, v2Execution: "on",
  instruction: { id: "ins-shelving-4", revision: 4, text: "move 1-6 forward, leave 3 alone", reportMode: "changes",
    outcome: "Staff shelve new stock with a location, a condition grade, and a validated ISBN (ABC-301, ABC-304, OPS-212)",
    included: [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], excluded: [{ target: shelf("atlas", 301), n: 3, reason: "leave alone" }] },
  rollup: [
    "Outcome: Staff shelve new stock with a location, a condition grade, and a validated ISBN (ABC-301, ABC-304, OPS-212) · 16 PRs: 1, 2, 4-17",
    "Validated: checks green, review threads resolved on 16 PRs; ISBN checksum test (c1)",
    "Still needed: review feedback: address it on 1 · worker · wake: its thread goes idle; checks green: CI on 5 · CI · wake: check results change",
    "Needs a decision: D1 Out-of-print ISBNs at entry: allow them, or block them? (7, 12); D2 Mark these drafts ready for review? (13-15)",
  ],
  contract: { outcomeValidated: false, completed: false, criteria: [
    { id: "checks-green", source: "gate", label: "checks green", status: "missing", affected: [{ target: shelf("spine", 214), n: 5 }],
      next: { action: "CI on 5", owner: "CI", wake: "check results change" } },
    { id: "c1", source: "user", label: "ISBN checksum test", status: "satisfied", affected: [], next: null },
  ] },
  observedAt: SHELVING_ROSTER_NOW,
  rows: SHELVING_ROWS,
  issues: [{ ref: "S1", cause: "launch-breaker", label: "Launch outcomes uncertain; new launches paused", detail: "Readback hasn't found the worker for 17 or ruled one out; running work continues",
    numbers: [17], raisedAt: AGO(2 * MINUTE), recovery: [{ command: "recheck launches", label: "Recheck launches", confirm: false }, { command: "reset 17 release", label: "Reset 17…", confirm: true }],
    likelyThreadId: "thr_folio_421" }],
  launches: { breakerOpen: true, capacityFull: false, uncertain: [{ n: 17, target: shelf("folio", 421), attemptId: "att-17", threadId: "thr_folio_421", since: AGO(3 * MINUTE) }] },
  ticketsWithoutPrs: [{ id: "OPS-219", title: "Shelf audit report", url: "https://linear.app/inkwell/issue/OPS-219" }],
  suggestions: [], history: { legacyJobs: 3, legacyPrs: 2, v2Attempts: 4 },
  decisions: [
    { id: "dec-shelving-1", n: 1, revision: 1, kind: "product", subkind: null, question: "Out-of-print ISBNs at entry: allow them, or block them?", createdAt: AGO(4 * MINUTE),
      answer: "command", options: [{ id: "A", label: "Allow, and show an \"Out of print\" badge", consequence: "12 already renders the badge; 7 adds one check" },
        { id: "B", label: "Block entry and route to the Rare desk", consequence: "Needs a Rare-desk route, about one more PR; 12 drops its badge" }],
      recommendation: { optionId: "A", numbers: null, reason: "Matches the ABC-318 acceptance note" },
      evidence: [{ label: "review thread on folio #415", url: shelf("folio", 415) }, { label: "ABC-318 acceptance note", url: "https://linear.app/inkwell/issue/ABC-318" }],
      source: { attemptId: "att-7", threadId: "thr_folio_415", label: "folio #415 worker" },
      targets: [{ target: shelf("folio", 415), n: 7, note: null, recommended: null }, { target: shelf("quill", 93), n: 12, note: null, recommended: null }] },
    { id: "dec-shelving-2", n: 2, revision: 1, kind: "lifecycle", subkind: "mark-ready", question: "Mark these drafts ready for review?", createdAt: AGO(4 * MINUTE),
      answer: "command", options: [], recommendation: { optionId: null, numbers: [13, 15], reason: "14 still has a TODO in its threshold" }, evidence: [], source: null,
      targets: [{ target: shelf("folio", 418), n: 13, note: null, recommended: true }, { target: shelf("atlas", 85), n: 14, note: "TODO left in the threshold", recommended: false },
        { target: shelf("catalog", 910), n: 15, note: null, recommended: true }] },
  ],
  lastCommand: { requestId: "req-shelving-41", text: "move 1-6 forward, leave 3 alone", origin: "panel", at: AGO(3 * MINUTE + 58 * SECOND), revision: 4, snapshotId: "S-41a7c3e90b2d",
    result: { kind: "admit", normalized: "move 1, 2, 4-6 forward except 3", rollup: null, revision: 4, mergePreviews: [],
      acknowledgment: ["Instruction r4 · 16 PRs · stops at Ready · reports changes", "Added: 4-6 (move forward)", "Still included: 7-17",
        "Already included, keeping their effects; name them to change them: 1, 2", "Left alone this instruction, not a hold: 3",
        "Held, skipped until released (a hold outlasts every instruction): 8",
        "Effects: 1, 2, 4-17 fix · test · push · reply · resolve threads · retarget · rerun failed checks · re-request review",
        "Next: 1 address_review_feedback; 2 fix_failing_checks; 4 read GitHub; 5 wait: ci; 6 wait: review"],
      parts: { added: [{ verb: "move forward", targets: refs(4, 5, 6) }], kept: refs(1, 2), stillIncluded: refs(...range(7, 17)), leftAlone: refs(3), held: refs(8), holds: [],
        released: [], superseded: [], dropped: [],
        effects: [{ targets: refs(1, 2, ...range(4, 17)), effects: ["code-fix", "test", "push", "pr-reply", "resolve-addressed-threads", "retarget-base", "rerun-checks", "request-rereview"] }],
        notGranted: ["mark-ready", "request-review"], interventions: [], answers: [],
        starting: [{ targets: refs(1), step: "address_review_feedback", resource: { kind: "reuse", reason: "idle, on the same branch" } },
          { targets: refs(2), step: "fix_failing_checks", resource: { kind: "spawn", reason: "the only quill thread is busy on #185" } },
          { targets: refs(4), step: "read GitHub", resource: null }, { targets: refs(5), step: "wait: ci", resource: null }, { targets: refs(6), step: "wait: review", resource: null }],
        merge: false } } },
  pending: [], through: 412,
  since: { rows: [
    { n: 7, from: "executing", to: "decision-needed", cause: "product", at: AGO(4 * MINUTE) },
    { n: 9, from: "verifying", to: "prepared", cause: "merge-candidate", at: AGO(20 * MINUTE) },
    { n: 16, from: "verifying", to: "prepared", cause: "merge-candidate", at: AGO(25 * MINUTE) },
    { n: 18, from: "prepared", to: "finished", cause: "merged", at: AGO(32 * MINUTE) },
  ], decisionsOpened: [1, 2], issuesOpened: ["S1"], newHeads: [4], handled: 9 },
};

/**
 * The PR inventory's acceptance shape (plan amendment A13): the 17 open PRs behind a live board's 14 "needs you" items, with Inkwell
 * names, as inventory_get returns them. The rows come through the functions the server composes (attention, stack parents, suggested
 * reviewers, rows, and the view), not written by hand, so a change to any of them that reclassifies a row fails the acceptance test.
 * - Ready to merge: folio #301 and #318, and the approved stack folio #340 → #341 → #342 → #343.
 * - Needs a nudge: catalog #96, asked of two reviewers on Monday.
 * - Waiting on parents: quill #212 on #210 (changes requested and conflicting), and spine #156 on #155 (changes requested).
 * - Code work, each with its thread except catalog #97: quill #210 and #211, spine #155, folio #330 (approved but conflicting),
 *   atlas #410, catalog #97, folio #325 (conflicting), and folio #305 (red checks).
 * - Missing a reviewer as well: atlas #410, folio #325, and folio #305.
 */
export const INVENTORY_NOW = Date.UTC(2026, 8, 30, 15);
export const INVENTORY_EFFORTS = { shelf: { id: "effort-shelf-order", name: "Shelf order" }, pickup: { id: "effort-store-pickup", name: "Store pickup" } };
export function inkwellInventory(): InventoryView {
  const day = 24 * HOUR;
  const iso = (at: number) => new Date(at).toISOString();
  const approved = (login = "mira-l"): Partial<Pr> => ({ reviewDecision: "APPROVED", latestReviewStates: ["APPROVED"],
    latestReviews: [{ login, state: "APPROVED", submittedAt: iso(INVENTORY_NOW - 2 * day) }] });
  const changes = (login: string): Partial<Pr> => ({ reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "BLOCKED", latestReviewStates: ["CHANGES_REQUESTED"],
    latestReviews: [{ login, state: "CHANGES_REQUESTED", submittedAt: iso(INVENTORY_NOW - day) }] });
  const asked = (hoursAgo: number, ...logins: string[]): Partial<Pr> => ({ reviewRequests: logins,
    reviewRequestedAt: logins.map((reviewer) => ({ reviewer, at: iso(INVENTORY_NOW - hoursAgo * HOUR) })) });
  const conflicting: Partial<Pr> = { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" };
  const since = (state: keyof StateSince): StateSince => ({ [state]: INVENTORY_NOW - 2 * day });
  type Spec = { repo: string; number: number; title: string; base?: number; effort?: keyof typeof INVENTORY_EFFORTS; facts?: Partial<Pr>; since?: StateSince;
    thread?: boolean; started?: boolean };
  const specs: Spec[] = [
    { repo: "folio", number: 301, title: "ABC-350 Show spine labels on shelf cards", facts: approved() },
    { repo: "folio", number: 318, title: "ABC-351 Keep the reading list sort", facts: approved("theo-k") },
    { repo: "folio", number: 340, title: "ABC-360 Store shelf order", effort: "shelf", facts: approved() },
    { repo: "folio", number: 341, title: "ABC-361 Read shelf order back", base: 340, effort: "shelf", facts: approved() },
    { repo: "folio", number: 342, title: "ABC-362 Drag to reorder shelves", base: 341, effort: "shelf", facts: approved() },
    { repo: "folio", number: 343, title: "ABC-363 Undo a shelf move", base: 342, effort: "shelf", facts: approved() },
    { repo: "catalog", number: 96, title: "ABC-121 Show series order on catalog pages", facts: asked(48, "mira-l", "theo-k") },
    { repo: "quill", number: 210, title: "ABC-370 Hold books at the counter", effort: "pickup", facts: { ...changes("otto-v"), ...conflicting },
      since: since("conflicting"), thread: true, started: true },
    { repo: "quill", number: 211, title: "ABC-371 Print hold slips", effort: "pickup", facts: changes("otto-v"), thread: true },
    { repo: "quill", number: 212, title: "ABC-372 Email when a hold is ready", base: 210, effort: "pickup", facts: approved("otto-v") },
    { repo: "spine", number: 155, title: "ABC-335 Remind readers before holds expire", effort: "pickup", facts: changes("ines-v"), thread: true },
    { repo: "spine", number: 156, title: "ABC-336 Release expired holds", base: 155, effort: "pickup", facts: approved("ines-v") },
    { repo: "folio", number: 330, title: "ABC-364 Keep shelf filters in the link", effort: "shelf", facts: { ...approved(), ...conflicting },
      since: since("conflicting"), thread: true },
    { repo: "atlas", number: 410, title: "ABC-210 Show delivery windows at checkout", facts: conflicting, since: since("conflicting"), thread: true },
    { repo: "catalog", number: 97, title: "ABC-122 Merge duplicate author records", facts: { ...asked(2, "ines-v"), ...conflicting }, since: since("conflicting") },
    { repo: "folio", number: 325, title: "ABC-355 Remember the last shelf you browsed", facts: conflicting, since: since("conflicting"), thread: true },
    { repo: "folio", number: 305, title: "ABC-352 Load cover images lazily", facts: { checkConclusions: ["FAILURE"], mergeStateStatus: "UNSTABLE" },
      since: since("ci-red"), thread: true },
  ];
  const branch = (number: number) => `abc-${number}-work`;
  const entries = specs.map((spec) => ({ repo: `inkwell/${spec.repo}`, pr: prSchema.parse({
    number: spec.number, state: "OPEN", isDraft: false, reviewDecision: "REVIEW_REQUIRED", checkConclusions: ["SUCCESS"], url: url(spec.repo, spec.number),
    title: spec.title, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", baseRefName: spec.base ? branch(spec.base) : "main", headRefName: branch(spec.number),
    headRefOid: spec.number.toString(16).padStart(40, "c"), latestReviewStates: [], createdAt: iso(INVENTORY_NOW - 6 * day),
    headCommittedAt: iso(INVENTORY_NOW - 3 * day), reviewRequestedAt: [], unresolvedReviewThreads: 0, resolvedReviewThreads: 0,
    approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] }, approvalFeedbackVerified: true, ...spec.facts }) }));
  const threads = new Map<string, ThreadRef>(specs.flatMap((spec): [string, ThreadRef][] => [
    ...spec.thread ? [[`thr_${spec.repo}_${spec.number}`, { title: `Work on ${spec.repo} #${spec.number}`, titleFallback: null, status: "idle", updatedAt: 2 }] as [string, ThreadRef]] : [],
    ...spec.started ? [[`thr_${spec.repo}_${spec.number}_plan`, { title: `Plan ${spec.title.slice(8)}`, titleFallback: null, status: "idle", updatedAt: 1 }] as [string, ThreadRef]] : []]));
  const link = (prUrl: string, threadId: string, sources: ResolvedThreadLink["sources"]): ResolvedThreadLink =>
    ({ prUrl, threadId, role: "pr", title: threads.get(threadId)!.title!, tier: "started", direct: true, sources });
  const checkedAt = iso(INVENTORY_NOW - 25_000);
  const rows = specs.map((spec, index) => {
    const entry = entries[index]!;
    const stackedOn = stackParent(entry, entries)?.pr.number ?? null;
    const { reasons } = prAttention({ ...entry.pr, stackedOn }, { holds: {}, effort: null, since: spec.since ?? {} },
      { now: INVENTORY_NOW, thresholds: DEFAULT_ATTENTION_THRESHOLDS, utcOffsetMinutes: 0 });
    const links = [...spec.thread ? [link(entry.pr.url, `thr_${spec.repo}_${spec.number}`, ["advance"])] : [],
      ...spec.started ? [link(entry.pr.url, `thr_${spec.repo}_${spec.number}_plan`, ["cluster"])] : []];
    const repository = entries.filter((other) => other.repo === entry.repo && other !== entry).map((other) => other.pr);
    return { effort: spec.effort ? INVENTORY_EFFORTS[spec.effort] : null, ...inventoryRow({ prUrl: entry.pr.url, pr: entry.pr, authored: true, stale: false, read: null,
      reasons, hold: null, observation: { checkedAt, failedAt: null, error: null }, managed: null, stackedOn, links, attemptThread: null, threads,
      suggestedReviewers: suggestReviewers(entry.pr, repository), lastAction: null }) };
  });
  return inventoryView(rows, { checkedAt, attemptedAt: checkedAt, refreshing: false, rateLimitedUntil: null, warnings: [] });
}
