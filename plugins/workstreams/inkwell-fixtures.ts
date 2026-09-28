// Fictional Inkwell bookstore data. The shapes copy recorded Workstreams state
// (batch sizes, overlaps, statuses, checkouts, and ownership); every name,
// number, path, and thread id is invented.
import { advanceBatchSchema, type AdvanceBatch, type AdvanceJob } from "./bulk-advance.js";
import { prSchema, type RawUnit } from "./contract.js";

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
