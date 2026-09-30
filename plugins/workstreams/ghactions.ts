// The Board's direct GitHub actions: merge, update branch, nudge reviewers.
// Every command is an argv ARRAY handed to execFile, never a shell string, so a
// PR title, branch name or comment can never be read as shell syntax. Comment
// bodies go in on stdin (`--body-file -`), never as a flag value. Every repo is
// named with `--repo`, which also stops `gh pr merge` from touching the local
// checkout. The runner is injected, so tests drive all of it against a fake.
import { parseMergeStateStatus } from "./gh.js";
import { SHA, type LiveMergeFacts, type MergeMethod } from "./actions.js";
import { createHash } from "node:crypto";
import { approvalFeedbackSchema, type ApprovalFeedbackSnapshot } from "./approval-feedback.js";
import { NOTE_MAX, type ApprovalHandling, type ApprovalSource } from "./approval-evidence.js";

export type Run = { ok: true; stdout: string } | { ok: false; error: string };
/** Runs `gh` with these arguments, optionally writing `stdin` to it. */
export type GhRunner = (args: readonly string[], stdin?: string) => Promise<Run>;

/** A pull request as `gh --repo` names it. `slug` is OWNER/REPO, or HOST/OWNER/REPO off github.com. */
export type PrTarget = { host: string; owner: string; name: string; slug: string; number: number };

const PR_URL = /^https:\/\/([A-Za-z0-9.-]+)\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})$/u;

/** The PR's repo and number from its URL, or null when the URL is not a PR URL. */
export function prTarget(url: string): PrTarget | null {
  const match = PR_URL.exec(url.trim());
  if (match === null) return null;
  const [, host, owner, name, number] = match as unknown as [string, string, string, string, string];
  if (name === "." || name === "..") return null;
  return {
    host,
    owner,
    name,
    slug: host === "github.com" ? `${owner}/${name}` : `${host}/${owner}/${name}`,
    number: Number(number),
  };
}

/** A GitHub login, or an org/team slug. Anything else is dropped, never passed to gh. */
export const REVIEWER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99})?$/u;

/**
 * `gh pr list --json reviewRequests`: users carry `login`; teams carry a
 * `slug`, qualified with the organization when gh reports it. Bounded and
 * validated, because these become `--add-reviewer` values.
 */
export function parseReviewRequests(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    let name: unknown = record.login;
    if (record.__typename === "Team") {
      const org = (record.organization as Record<string, unknown> | undefined)?.login;
      const slug = record.slug;
      name = typeof slug === "string" && !slug.includes("/") && typeof org === "string" ? `${org}/${slug}` : slug;
    }
    if (typeof name === "string" && REVIEWER.test(name) && !out.includes(name)) out.push(name);
  }
  return out.slice(0, 20);
}

const repoArgs = (target: PrTarget) => [String(target.number), "--repo", target.slug];

export function viewArgv(target: PrTarget): string[] {
  return ["pr", "view", ...repoArgs(target), "--json", "state,isDraft,reviewDecision,mergeStateStatus,headRefOid,headRefName"];
}

export function stackedArgv(target: PrTarget, headRefName: string): string[] {
  return ["pr", "list", "--repo", target.slug, "--base", headRefName, "--state", "open", "--json", "number", "--limit", "50"];
}

/** Constant: the only variables are passed as typed -f/-F fields, never spliced in. */
export const REVIEW_THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!,$includeFollowup:Boolean!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefOid baseRefName baseRef{name target{oid}} author{login} reviews(last:100){pageInfo{hasPreviousPage startCursor}nodes{id state body submittedAt author{login} commit{oid}}} reviewThreads(first:100){pageInfo{hasNextPage endCursor}nodes{id isResolved comments(first:100){pageInfo{hasNextPage endCursor}nodes{id body createdAt updatedAt author{login} pullRequestReview{id}}}}} comments(last:100) @include(if:$includeFollowup){pageInfo{hasPreviousPage}nodes{body createdAt author{login}}} commits(last:1) @include(if:$includeFollowup){nodes{commit{oid committedDate}}}}}}";

const REVIEWS_PAGE_QUERY = "query($owner:String!,$name:String!,$number:Int!,$cursor:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviews(last:100,before:$cursor){pageInfo{hasPreviousPage startCursor}nodes{id state body submittedAt author{login} commit{oid}}}}}}";
const THREADS_PAGE_QUERY = "query($owner:String!,$name:String!,$number:Int!,$cursor:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id isResolved comments(first:100){pageInfo{hasNextPage endCursor}nodes{id body createdAt updatedAt author{login} pullRequestReview{id}}}}}}}}";
const COMMENTS_PAGE_QUERY = "query($owner:String!,$name:String!,$number:Int!,$id:ID!,$cursor:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid}} node(id:$id){... on PullRequestReviewThread{id comments(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id body createdAt updatedAt author{login} pullRequestReview{id}}}}}}";

export type { ApprovalFeedbackSnapshot } from "./approval-feedback.js";
const UNKNOWN_FEEDBACK: ApprovalFeedbackSnapshot = { status: "unknown", fingerprint: null, sourceIds: [] };
const NONE_FEEDBACK: ApprovalFeedbackSnapshot = { status: "none", fingerprint: null, sourceIds: [] };

export function threadsArgv(target: PrTarget, includeFollowup = false): string[] {
  return [
    "api",
    "graphql",
    ...(target.host === "github.com" ? [] : ["--hostname", target.host]),
    "-f",
    `query=${REVIEW_THREADS_QUERY}`,
    "-f",
    `owner=${target.owner}`,
    "-f",
    `name=${target.name}`,
    "-F",
    `number=${target.number}`,
    "-F",
    `includeFollowup=${includeFollowup}`,
  ];
}

export function mergeArgv(target: PrTarget, method: MergeMethod, sha: string, deleteBranch: boolean): string[] {
  if (!SHA.test(sha)) throw new Error("A merge needs the exact head commit it was confirmed against.");
  return ["pr", "merge", ...repoArgs(target), `--${method}`, "--match-head-commit", sha, ...(deleteBranch ? ["--delete-branch"] : [])];
}

export function updateBranchArgv(target: PrTarget): string[] {
  return ["pr", "update-branch", ...repoArgs(target)];
}

export function rerequestArgv(target: PrTarget, reviewers: readonly string[]): string[] {
  const valid = reviewers.filter((reviewer) => REVIEWER.test(reviewer));
  if (valid.length === 0) throw new Error("No valid reviewers to re-request.");
  return ["pr", "edit", ...repoArgs(target), "--add-reviewer", valid.join(",")];
}

export function readyArgv(target: PrTarget): string[] {
  return ["pr", "ready", ...repoArgs(target)];
}

/** The GitHub Actions runs on one head commit, with each run's attempt number, so a rerun that already happened shows. */
export function headRunsArgv(target: PrTarget, headOid: string): string[] {
  if (!SHA.test(headOid)) throw new Error("Reading a head's runs needs its exact commit.");
  return ["run", "list", "--repo", target.slug, "--commit", headOid, "--json", "databaseId,attempt,status,conclusion", "--limit", "100"];
}

export function rerunFailedArgv(target: PrTarget, runId: number): string[] {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("A rerun needs a GitHub Actions run id.");
  return ["run", "rerun", String(runId), "--failed", "--repo", target.slug];
}

/** The body is NOT in here: it goes on stdin. */
export function commentArgv(target: PrTarget): string[] {
  return ["pr", "comment", ...repoArgs(target), "--body-file", "-"];
}

function json(run: Run): unknown {
  if (!run.ok) return undefined;
  try {
    return JSON.parse(run.stdout);
  } catch {
    return undefined;
  }
}

export type LiveRead = { ok: true; live: LiveMergeFacts } | { ok: false; error: string };

export type ApprovalNote = { author: string; body: string; submittedAt: string; truncated: boolean };
const APPROVAL_NOTE_MAX = 1_200;
const APPROVAL_NOTES_SHOWN = 3;

function approvalNotesOf(reviews: unknown): { notes: ApprovalNote[]; more: number; complete: boolean } {
  const incomplete = { notes: [], more: 0, complete: false };
  if (reviews === null || typeof reviews !== "object") return incomplete;
  const page = reviews as { pageInfo?: { hasPreviousPage?: unknown }; nodes?: unknown };
  if (typeof page.pageInfo?.hasPreviousPage !== "boolean" || !Array.isArray(page.nodes)) return incomplete;
  const notes: ApprovalNote[] = [];
  for (const entry of page.nodes) {
    if (entry === null || typeof entry !== "object") return incomplete;
    const review = entry as { state?: unknown; body?: unknown; submittedAt?: unknown; author?: { login?: unknown } };
    if (review.state !== "APPROVED" || typeof review.body !== "string" || review.body.trim() === "") continue;
    if (typeof review.author?.login !== "string" || typeof review.submittedAt !== "string" ||
        Number.isNaN(Date.parse(review.submittedAt))) return incomplete;
    const body = review.body.trim();
    notes.push({ author: review.author.login.slice(0, 140), body: body.slice(0, APPROVAL_NOTE_MAX),
      submittedAt: review.submittedAt, truncated: body.length > APPROVAL_NOTE_MAX });
  }
  notes.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  return { notes: notes.slice(0, APPROVAL_NOTES_SHOWN), more: Math.max(0, notes.length - APPROVAL_NOTES_SHOWN), complete: !page.pageInfo.hasPreviousPage };
}

type Page = { pageInfo?: { hasPreviousPage?: unknown; startCursor?: unknown; hasNextPage?: unknown; endCursor?: unknown }; nodes?: unknown };
type Review = { id: string; state: string; body: string; submittedAt: string; author: { login: string }; commit: { oid: string } };
type ThreadComment = { id: string; body: string; createdAt: string; updatedAt: string; author: { login: string }; pullRequestReview: { id: string } | null };
type Thread = { id: string; isResolved: boolean; comments: Page };
const MAX_PAGES = 20;

function pageArgs(target: PrTarget, query: string, fields: string[]): string[] {
  return ["api", "graphql", ...(target.host === "github.com" ? [] : ["--hostname", target.host]),
    "-f", `query=${query}`, "-f", `owner=${target.owner}`, "-f", `name=${target.name}`, "-F", `number=${target.number}`, ...fields];
}

function connection(value: unknown, direction: "previous" | "next"): { nodes: unknown[]; more: boolean; cursor: string | null } | null {
  if (value === null || typeof value !== "object") return null;
  const page = value as Page;
  const more = direction === "previous" ? page.pageInfo?.hasPreviousPage : page.pageInfo?.hasNextPage;
  const cursor = direction === "previous" ? page.pageInfo?.startCursor : page.pageInfo?.endCursor;
  if (!Array.isArray(page.nodes) || typeof more !== "boolean" || (more && (typeof cursor !== "string" || cursor === ""))) return null;
  return { nodes: page.nodes, more, cursor: more ? cursor as string : null };
}

function isReview(value: unknown): value is Review {
  if (value === null || typeof value !== "object") return false;
  const review = value as Partial<Review>;
  return typeof review.id === "string" && review.id !== "" && typeof review.state === "string" &&
    typeof review.body === "string" && typeof review.submittedAt === "string" && !Number.isNaN(Date.parse(review.submittedAt)) &&
    typeof review.author?.login === "string" && typeof review.commit?.oid === "string" && SHA.test(review.commit.oid);
}

function isComment(value: unknown): value is ThreadComment {
  if (value === null || typeof value !== "object") return false;
  const comment = value as Partial<ThreadComment>;
  return typeof comment.id === "string" && comment.id !== "" && typeof comment.body === "string" &&
    typeof comment.createdAt === "string" && !Number.isNaN(Date.parse(comment.createdAt)) &&
    typeof comment.updatedAt === "string" && !Number.isNaN(Date.parse(comment.updatedAt)) &&
    typeof comment.author?.login === "string" &&
    (comment.pullRequestReview === null || typeof comment.pullRequestReview?.id === "string");
}

function isThread(value: unknown): value is Thread {
  if (value === null || typeof value !== "object") return false;
  const thread = value as Partial<Thread>;
  return typeof thread.id === "string" && thread.id !== "" && typeof thread.isResolved === "boolean" &&
    connection(thread.comments, "next") !== null;
}

/** What a present feedback snapshot was computed from: its approving and follow-up reviews, the threads they opened, every review, and the PR's author. */
type FeedbackDetail = { approvals: Review[]; followups: Review[]; linked: { thread: Thread; review: Review; comments: ThreadComment[] }[]; reviews: Review[];
  author: string | null };

async function approvalFeedbackOf(run: GhRunner, target: PrTarget, pr: Record<string, unknown>):
  Promise<{ snapshot: ApprovalFeedbackSnapshot; threadNodes?: Thread[]; detail?: FeedbackDetail }> {
  const head = pr.headRefOid;
  if (typeof head !== "string" || !SHA.test(head)) return { snapshot: UNKNOWN_FEEDBACK };
  const reviews = connection(pr.reviews, "previous");
  const threads = connection(pr.reviewThreads, "next");
  if (reviews === null || threads === null) return { snapshot: UNKNOWN_FEEDBACK };
  const allReviews = [...reviews.nodes];
  const allThreads = [...threads.nodes];
  let paged = false;

  async function extend(kind: "reviews" | "reviewThreads", first: { more: boolean; cursor: string | null }, nodes: unknown[]): Promise<boolean> {
    let { more, cursor } = first;
    const seen = new Set<string>();
    for (let page = 1; more; page++) {
      paged = true;
      if (page >= MAX_PAGES || cursor === null || seen.has(cursor)) return false;
      seen.add(cursor);
      const query = kind === "reviews" ? REVIEWS_PAGE_QUERY : THREADS_PAGE_QUERY;
      const result = await run(pageArgs(target, query, ["-f", `cursor=${cursor}`]));
      const body = json(result) as { errors?: unknown; data?: { repository?: { pullRequest?: Record<string, unknown> } } } | undefined;
      const nextPr = body?.data?.repository?.pullRequest;
      if (body?.errors !== undefined || nextPr?.headRefOid !== head) return false;
      const next = connection(nextPr?.[kind], kind === "reviews" ? "previous" : "next");
      if (next === null || next.nodes.length === 0) return false;
      nodes.push(...next.nodes);
      more = next.more;
      cursor = next.cursor;
    }
    return true;
  }
  if (!await extend("reviews", reviews, allReviews) || !await extend("reviewThreads", threads, allThreads)) return { snapshot: UNKNOWN_FEEDBACK };
  if (!allReviews.every(isReview) || !allThreads.every(isThread)) return { snapshot: UNKNOWN_FEEDBACK };
  const reviewIds = new Set<string>();
  for (const review of allReviews) {
    if (reviewIds.has(review.id)) return { snapshot: UNKNOWN_FEEDBACK };
    reviewIds.add(review.id);
  }
  const byReviewer = new Map<string, Review[]>();
  for (const review of allReviews) {
    const history = byReviewer.get(review.author.login) ?? [];
    history.push(review);
    byReviewer.set(review.author.login, history);
  }
  const approvals: Review[] = [];
  const followups: Review[] = [];
  for (const history of byReviewer.values()) {
    history.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
    if (history.some((review, index) => index > 0 && review.submittedAt === history[index - 1]!.submittedAt &&
        (review.state !== "COMMENTED" || history[index - 1]!.state !== "COMMENTED"))) return { snapshot: UNKNOWN_FEEDBACK };
    let approval: Review | null = null;
    let laterComments: Review[] = [];
    for (const review of history) {
      if (review.state === "APPROVED") { approval = review; laterComments = []; }
      else if (review.state === "CHANGES_REQUESTED" || review.state === "DISMISSED") { approval = null; laterComments = []; }
      else if (review.state === "COMMENTED" && approval !== null) laterComments.push(review);
      else if (review.state !== "COMMENTED") return { snapshot: UNKNOWN_FEEDBACK };
    }
    if (approval !== null) { approvals.push(approval); followups.push(...laterComments); }
  }
  approvals.sort((a, b) => a.id.localeCompare(b.id));
  followups.sort((a, b) => a.id.localeCompare(b.id));
  const approvalById = new Map([...approvals, ...followups].map((review) => [review.id, review]));
  const prAuthor = (pr.author as { login?: unknown } | undefined)?.login;
  const linked: { thread: Thread; review: Review; comments: ThreadComment[] }[] = [];
  const threadIds = new Set<string>();
  for (const thread of allThreads) {
    if (threadIds.has(thread.id)) return { snapshot: UNKNOWN_FEEDBACK };
    threadIds.add(thread.id);
    const first = connection(thread.comments, "next");
    if (first === null || first.nodes.length === 0 || !isComment(first.nodes[0])) return { snapshot: UNKNOWN_FEEDBACK };
    if (first.nodes[0].pullRequestReview === null && approvals.length > 0) return { snapshot: UNKNOWN_FEEDBACK };
    const review = approvalById.get(first.nodes[0].pullRequestReview?.id ?? "");
    if (review === undefined) continue;
    const comments = [...first.nodes];
    let { more, cursor } = first;
    const seen = new Set<string>();
    for (let page = 1; more; page++) {
      paged = true;
      if (page >= MAX_PAGES || cursor === null || seen.has(cursor)) return { snapshot: UNKNOWN_FEEDBACK };
      seen.add(cursor);
      const result = await run(pageArgs(target, COMMENTS_PAGE_QUERY, ["-f", `id=${thread.id}`, "-f", `cursor=${cursor}`]));
      const body = json(result) as { errors?: unknown; data?: { repository?: { pullRequest?: { headRefOid?: unknown } }; node?: { id?: unknown; comments?: unknown } } } | undefined;
      if (body?.errors !== undefined || body?.data?.repository?.pullRequest?.headRefOid !== head || body?.data?.node?.id !== thread.id) return { snapshot: UNKNOWN_FEEDBACK };
      const next = connection(body.data.node.comments, "next");
      if (next === null || next.nodes.length === 0) return { snapshot: UNKNOWN_FEEDBACK };
      comments.push(...next.nodes);
      more = next.more;
      cursor = next.cursor;
    }
    if (!comments.every(isComment) || new Set(comments.map((comment) => comment.id)).size !== comments.length) return { snapshot: UNKNOWN_FEEDBACK };
    linked.push({ thread, review, comments: comments as ThreadComment[] });
  }
  if (paged) {
    const repeated = json(await run(threadsArgv(target))) as { errors?: unknown; data?: { repository?: { pullRequest?: Record<string, unknown> } } } | undefined;
    const current = repeated?.data?.repository?.pullRequest;
    if (repeated?.errors !== undefined || current?.headRefOid !== head ||
        JSON.stringify(current.reviews) !== JSON.stringify(pr.reviews) ||
        JSON.stringify(current.reviewThreads) !== JSON.stringify(pr.reviewThreads) ||
        JSON.stringify(current.author) !== JSON.stringify(pr.author)) return { snapshot: UNKNOWN_FEEDBACK };
  }
  const sourceIds = [...new Set([
    ...[...approvals, ...followups].filter((review) => review.body.trim() !== "").map((review) => review.id),
    ...linked.map(({ thread }) => thread.id),
  ])].sort();
  if (sourceIds.length === 0) return { snapshot: NONE_FEEDBACK, threadNodes: allThreads as Thread[] };
  if (linked.length > 0 && typeof prAuthor !== "string") return { snapshot: UNKNOWN_FEEDBACK };
  const canonical = {
    approvals: approvals.map((review) => ({ id: review.id, body: review.body })),
    followups: followups.filter((review) => review.body.trim() !== "" || linked.some(({ review: linkedReview }) => linkedReview.id === review.id))
      .map((review) => ({ id: review.id, body: review.body })),
    threads: linked.sort((a, b) => a.thread.id.localeCompare(b.thread.id)).map(({ thread, review, comments }) => ({
      id: thread.id, reviewId: review.id, comments: comments.filter((comment) => comment.author.login === review.author.login).map((comment) => ({ id: comment.id,
        body: comment.body, updatedAt: comment.updatedAt })),
    })),
  };
  const contents = JSON.stringify(canonical);
  const snapshot = { status: "present", fingerprint: createHash("sha256").update(contents).digest("hex"), sourceIds };
  if (contents.length > 50_000 || !approvalFeedbackSchema.safeParse(snapshot).success) return { snapshot: UNKNOWN_FEEDBACK };
  return { snapshot: snapshot as ApprovalFeedbackSnapshot,
    threadNodes: allThreads as Thread[],
    detail: { approvals, followups, linked, reviews: allReviews as Review[], author: typeof prAuthor === "string" ? prAuthor : null } };
}

/** Read all available review, thread, and linked comment pages before claiming feedback is clear. */
export async function readReviewThreads(run: GhRunner, target: PrTarget, includeFollowup = false, includeApprovalNotes = false): Promise<{ ok: true; count: number; resolvedCount: number | null; hasNextPage: boolean; headOid: string | null; approvalFeedback: ApprovalFeedbackSnapshot; reviewFollowupPosted?: boolean; approvalNotes?: ApprovalNote[]; approvalNotesMore?: number; approvalNotesComplete?: boolean } | { ok: false; error: string }> {
  const result = await run(threadsArgv(target, includeFollowup));
  if (!result.ok) return { ok: false, error: result.error };
  const body = json(result) as { errors?: unknown; data?: { repository?: { pullRequest?: { reviewThreads?: unknown; reviews?: unknown; headRefOid?: unknown; author?: unknown; comments?: unknown; commits?: unknown } } } } | undefined;
  if (body === undefined || body.errors !== undefined) return { ok: false, error: "GitHub did not return complete review thread data." };
  const pr = body.data?.repository?.pullRequest;
  const threads = pr?.reviewThreads as { pageInfo?: { hasNextPage?: unknown }; nodes?: unknown } | undefined;
  if (!Array.isArray(threads?.nodes) || typeof threads.pageInfo?.hasNextPage !== "boolean" ||
      !threads.nodes.every((node) => node !== null && typeof node === "object" && typeof node.isResolved === "boolean")) {
    return { ok: false, error: "GitHub did not return the PR's review threads." };
  }
  const threadNodes = threads.nodes as { isResolved: boolean; comments?: { nodes?: { pullRequestReview?: { id?: string } }[] } }[];
  const reviews = pr?.reviews as { pageInfo?: { hasPreviousPage?: unknown }; nodes?: unknown } | undefined;
  const approvalHistory = includeApprovalNotes ? approvalNotesOf(reviews) : undefined;
  const feedbackRead = await approvalFeedbackOf(run, target, pr as Record<string, unknown>);
  const approvalFeedback = feedbackRead.snapshot;
  const countedNodes = feedbackRead.threadNodes ?? threadNodes;
  const count = countedNodes.filter((node) => node.isResolved === false).length;
  const hasNextPage = feedbackRead.threadNodes === undefined && threads.pageInfo.hasNextPage;
  if (count === 0 && hasNextPage) return { ok: false, error: "More review thread pages remain unread." };
  let reviewFollowupPosted: boolean | undefined;
  if (count === 0 && !threads.pageInfo.hasNextPage && SHA.test(String(pr?.headRefOid)) &&
      reviews?.pageInfo?.hasPreviousPage === false && Array.isArray(reviews.nodes)) {
    // GitHub's latestReviews is per reviewer for changes-requested follow-up.
    const latest = new Map<string, { id?: string; state?: string; body?: string; submittedAt?: string; commit?: { oid?: string } }>();
    let complete = true;
    for (const review of reviews.nodes) {
      const author = review?.author?.login;
      const submittedAt = review?.submittedAt;
      if (typeof author !== "string" || typeof submittedAt !== "string" || Number.isNaN(Date.parse(submittedAt))) {
        complete = false;
        break;
      }
      if ((latest.get(author)?.submittedAt ?? "") <= submittedAt) latest.set(author, review);
    }
    if (complete) {
      const latestReviews = [...latest.entries()];
      if (includeFollowup) {
        const comments = pr?.comments as { nodes?: unknown } | undefined;
        const commits = pr?.commits as { nodes?: unknown } | undefined;
        const author = (pr?.author as { login?: unknown } | undefined)?.login;
        const headCommit = Array.isArray(commits?.nodes) ? commits.nodes[0]?.commit : undefined;
        const commentNodes = Array.isArray(comments?.nodes) ? comments.nodes as { author?: { login?: string }; createdAt?: string; body?: string }[] : null;
        const requested = latestReviews.filter(([, review]) => review.state === "CHANGES_REQUESTED");
        if (typeof author === "string" && commentNodes !== null &&
            headCommit?.oid === pr?.headRefOid && typeof headCommit?.committedDate === "string" && requested.length > 0) {
          reviewFollowupPosted = requested.every(([reviewer, review]) =>
            typeof review.submittedAt === "string" &&
            Date.parse(headCommit.committedDate) > Date.parse(review.submittedAt) &&
            commentNodes.some((comment) =>
              comment?.author?.login === author && typeof comment.createdAt === "string" &&
              Date.parse(comment.createdAt) > Date.parse(review.submittedAt!) &&
              Date.parse(comment.createdAt) >= Date.parse(headCommit.committedDate) &&
              typeof comment.body === "string" && /\bPTAL\b/iu.test(comment.body) &&
              comment.body.toLowerCase().includes(`@${reviewer.toLowerCase()}`)));
        }
      }
    }
  }
  return {
    ok: true,
    count,
    resolvedCount: hasNextPage ? null : countedNodes.length - count,
    hasNextPage,
    headOid: typeof pr?.headRefOid === "string" && SHA.test(pr.headRefOid) ? pr.headRefOid : null,
    approvalFeedback,
    ...(reviewFollowupPosted === undefined ? {} : { reviewFollowupPosted }),
    ...(approvalHistory === undefined ? {} : { approvalNotes: approvalHistory.notes, approvalNotesMore: approvalHistory.more, approvalNotesComplete: approvalHistory.complete }),
  };
}

const ACTIVITY_QUERY = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid commits(last:100){pageInfo{hasPreviousPage}nodes{commit{oid committedDate}}}}}}";

/**
 * Read-only: an approval's notes, as the approval feedback's own sources, and what came after the newest of them: commits, replies from
 * the PR's author (PR comments, reviews, and thread comments), and the inline threads the newest note opened resolved. The notes come from the same
 * paged read as the feedback's fingerprint, and the commits from one more read that must see the same head.
 */
export async function readApprovalHandling(run: GhRunner, target: PrTarget): Promise<ApprovalHandling> {
  const result = await run(threadsArgv(target, true));
  if (!result.ok) return { ok: false, error: result.error };
  const body = json(result) as { errors?: unknown; data?: { repository?: { pullRequest?: Record<string, unknown> } } } | undefined;
  const pr = body?.data?.repository?.pullRequest;
  if (body?.errors !== undefined || !pr) return { ok: false, error: "GitHub did not return the PR's reviews." };
  const { snapshot, detail } = await approvalFeedbackOf(run, target, pr);
  if (snapshot.status !== "present" || !detail) return { ok: false, error: snapshot.status === "none" ? "The approval left no notes."
    : "GitHub didn't return the approval's notes in full. Refresh and try again." };
  const head = pr.headRefOid as string;
  const activity = json(await run(pageArgs(target, ACTIVITY_QUERY, []))) as { data?: { repository?: { pullRequest?: { headRefOid?: unknown;
    commits?: { pageInfo?: { hasPreviousPage?: unknown }; nodes?: unknown } } } } } | undefined;
  const later = activity?.data?.repository?.pullRequest;
  if (later?.headRefOid !== head) return { ok: false, error: "The PR's head changed while it was read. Try again." };
  const commits = Array.isArray(later.commits?.nodes) ? (later.commits.nodes as { commit?: { oid?: unknown; committedDate?: unknown } }[]) : null;
  if (commits === null || !commits.every((node) => typeof node?.commit?.oid === "string" && typeof node.commit.committedDate === "string")) {
    return { ok: false, error: "GitHub did not return the PR's commits." };
  }
  const noted = [...detail.approvals, ...detail.followups].filter((review) => review.body.trim() !== "");
  // The newest note, and the head it was left on: only what came after it counts.
  const last = [...noted, ...detail.linked.map(({ review }) => review)].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt)).at(-1)!;
  const since = Date.parse(last.submittedAt);
  const after = (at: unknown) => typeof at === "string" && Date.parse(at) > since;
  const oids = commits.map((node) => node.commit!.oid as string);
  const at = oids.indexOf(last.commit.oid);
  // Its head gone from the last 100 commits means more than that many since, or history rewritten after it: either way, new commits.
  const newCommits = at >= 0 ? oids.length - 1 - at : head === last.commit.oid ? 0
    : Math.max(1, commits.filter((node) => after(node.commit!.committedDate)).length);
  const author = detail.author;
  const comments = pr.comments as { pageInfo?: { hasPreviousPage?: unknown }; nodes?: unknown } | undefined;
  const commentNodes = Array.isArray(comments?.nodes) ? comments.nodes as { createdAt?: unknown; author?: { login?: unknown } | null }[] : null;
  const byAuthor = (login: unknown) => author !== null && login === author;
  const reviews = detail.reviews.filter((review) => byAuthor(review.author.login) && after(review.submittedAt));
  const reviewIds = new Set(reviews.map((review) => review.id));
  const replies = (commentNodes ?? []).filter((comment) => byAuthor(comment?.author?.login) && after(comment?.createdAt)).length + reviews.length +
    detail.linked.flatMap(({ comments: thread }) => thread).filter((comment) => byAuthor(comment.author.login) && after(comment.createdAt) &&
      !reviewIds.has(comment.pullRequestReview?.id ?? "")).length;
  // A reply older than the last 100 PR comments would still be newer than the note only when all 100 are: that page can't rule one out.
  const cut = commentNodes === null || (comments?.pageInfo?.hasPreviousPage === true && commentNodes.every((comment) => after(comment?.createdAt)));
  // A thread's resolution has no date, so only the threads the newest note opened can show it was resolved after that note.
  const current = detail.linked.filter(({ review }) => Date.parse(review.submittedAt) >= since);
  const note = (text: string) => ({ body: text.trim().slice(0, NOTE_MAX), truncated: text.trim().length > NOTE_MAX });
  const sources: ApprovalSource[] = [
    ...noted.map((review): ApprovalSource => ({ id: review.id, kind: "review", author: review.author.login, at: review.submittedAt, ...note(review.body), resolved: null })),
    ...detail.linked.map(({ thread, comments: [first] }): ApprovalSource => ({ id: thread.id, kind: "thread", author: first!.author.login, at: first!.createdAt,
      ...note(first!.body), resolved: thread.isResolved })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return { ok: true, headOid: head, fingerprint: snapshot.fingerprint!, sources,
    evidence: { since: last.submittedAt, commits: newCommits, replies, complete: author !== null && !cut,
      threads: { total: current.length, resolved: current.filter(({ thread }) => thread.isResolved).length } } };
}

/**
 * Re-read, live, everything the merge dialog shows: the PR's own state, any
 * open PR stacked on its head branch, and how many review threads are still
 * unresolved. Three read-only calls; nothing here writes.
 */
export async function readLiveMerge(run: GhRunner, target: PrTarget): Promise<LiveRead> {
  const viewed = await run(viewArgv(target));
  if (!viewed.ok) return { ok: false, error: `gh pr view failed: ${viewed.error}` };
  const view = json(viewed) as Record<string, unknown> | undefined;
  if (view === undefined || view === null || typeof view !== "object") return { ok: false, error: "gh pr view returned no data." };
  const head = typeof view.headRefName === "string" && !view.headRefName.startsWith("-") ? view.headRefName : null;
  const [stacked, threads] = await Promise.all([
    head === null ? Promise.resolve<Run>({ ok: true, stdout: "[]" }) : run(stackedArgv(target, head)),
    readReviewThreads(run, target, false, true),
  ]);
  if (!stacked.ok) return { ok: false, error: `Could not check for stacked PRs: ${stacked.error}` };
  if (!threads.ok) return { ok: false, error: `Could not count unresolved review threads: ${threads.error}` };
  if (threads.headOid !== view.headRefOid) return { ok: false, error: "The PR head changed during review verification." };
  const above = json(stacked);
  return {
    ok: true,
    live: {
      state: typeof view.state === "string" ? view.state.toUpperCase() : "",
      isDraft: view.isDraft === true,
      reviewDecision: typeof view.reviewDecision === "string" && view.reviewDecision !== "" ? view.reviewDecision.toUpperCase() : null,
      mergeStateStatus: parseMergeStateStatus(view.mergeStateStatus),
      headRefOid: typeof view.headRefOid === "string" && SHA.test(view.headRefOid) ? view.headRefOid : null,
      stackedAbove: Array.isArray(above)
        ? above.flatMap((entry) => (typeof entry?.number === "number" ? [entry.number as number] : [])).slice(0, 50)
        : [],
      unresolvedThreads: threads.count,
      unresolvedAtLeast: threads.hasNextPage,
      approvalNotes: threads.approvalNotes ?? [],
      approvalNotesMore: threads.approvalNotesMore ?? 0,
      approvalNotesComplete: threads.approvalNotesComplete ?? false,
      approvalFeedback: threads.approvalFeedback,
    },
  };
}

export type WriteResult = { ok: true; detail: string } | { ok: false; error: string };

export async function runMerge(
  run: GhRunner,
  target: PrTarget,
  method: MergeMethod,
  sha: string,
  deleteBranch: boolean,
): Promise<WriteResult> {
  const merged = await run(mergeArgv(target, method, sha, deleteBranch));
  return merged.ok
    ? { ok: true, detail: `Merged ${target.slug} #${target.number}${deleteBranch ? " and deleted its branch" : ""}.` }
    : { ok: false, error: `GitHub refused the merge: ${merged.error}` };
}

export async function runUpdateBranch(run: GhRunner, target: PrTarget): Promise<WriteResult> {
  const updated = await run(updateBranchArgv(target));
  return updated.ok
    ? { ok: true, detail: `Updated the branch of ${target.slug} #${target.number}.` }
    : { ok: false, error: `GitHub refused the branch update: ${updated.error}` };
}

/** Re-request review and/or comment. Each part is optional; a failure says which part failed. */
export async function runNudge(
  run: GhRunner,
  target: PrTarget,
  reviewers: readonly string[],
  comment: string | null,
): Promise<WriteResult> {
  const done: string[] = [];
  if (reviewers.length > 0) {
    const edited = await run(rerequestArgv(target, reviewers));
    if (!edited.ok) return { ok: false, error: `Re-requesting review failed: ${edited.error}` };
    done.push(`re-requested review from ${reviewers.length}`);
  }
  if (comment !== null && comment.trim() !== "") {
    const posted = await run(commentArgv(target), comment);
    if (!posted.ok) {
      return { ok: false, error: `${done.length > 0 ? "Review was re-requested, but posting" : "Posting"} the comment failed: ${posted.error}` };
    }
    done.push("posted the comment");
  }
  if (done.length === 0) return { ok: false, error: "Nothing to do: choose re-request, a comment, or both." };
  return { ok: true, detail: `${target.slug} #${target.number}: ${done.join(" and ")}.` };
}

/** A write refused because the PR's head is no longer the one it was confirmed on: nothing was written, and the PR must be read again. */
export const HEAD_MOVED = "The PR head moved since it was read; nothing was written.";

/** Mark a draft ready for review, only on the head it was confirmed on. A PR already ready is left alone. */
export async function runReady(run: GhRunner, target: PrTarget, headOid: string): Promise<WriteResult> {
  if (!SHA.test(headOid)) throw new Error("Marking a PR ready needs the exact head it was confirmed on.");
  const viewed = await run(["pr", "view", ...repoArgs(target), "--json", "state,isDraft,headRefOid"]);
  if (!viewed.ok) return { ok: false, error: `gh pr view failed: ${viewed.error}` };
  const view = json(viewed) as { state?: unknown; isDraft?: unknown; headRefOid?: unknown } | undefined;
  if (view?.headRefOid !== headOid) return { ok: false, error: HEAD_MOVED };
  if (view.state !== "OPEN") return { ok: false, error: "This pull request is no longer open." };
  if (view.isDraft === false) return { ok: true, detail: `${target.slug} #${target.number} is already ready for review.` };
  const marked = await run(readyArgv(target));
  return marked.ok ? { ok: true, detail: `Marked ${target.slug} #${target.number} ready for review.` }
    : { ok: false, error: `GitHub refused to mark the PR ready: ${marked.error}` };
}

/**
 * Rerun only the failed jobs of each failed GitHub Actions run on this head, and never twice: once any run on the
 * head was rerun, by anyone, nothing is rerun again. A head with no failed Actions run has nothing to rerun.
 */
export async function runRerunFailed(run: GhRunner, target: PrTarget, headOid: string): Promise<WriteResult> {
  const listed = await run(headRunsArgv(target, headOid));
  if (!listed.ok) return { ok: false, error: `Could not list the head's GitHub Actions runs: ${listed.error}` };
  const runs = json(listed);
  if (!Array.isArray(runs) || !runs.every((entry) => typeof entry?.databaseId === "number" && typeof entry.attempt === "number"))
    return { ok: false, error: "GitHub did not return the head's GitHub Actions runs." };
  const head = headOid.slice(0, 7);
  if (runs.some((entry) => entry.attempt > 1)) return { ok: true, detail: `A GitHub Actions run on ${head} was already rerun, so nothing was rerun again.` };
  const failed = runs.filter((entry) => entry.status === "completed" && ["failure", "timed_out"].includes(entry.conclusion));
  if (failed.length === 0) return { ok: true, detail: `No GitHub Actions run failed on ${head}, so there was nothing to rerun.` };
  for (const entry of failed) {
    const rerun = await run(rerunFailedArgv(target, entry.databaseId));
    if (!rerun.ok) return { ok: false, error: `GitHub refused to rerun run ${entry.databaseId}: ${rerun.error}` };
  }
  return { ok: true, detail: `Reran the failed jobs of ${failed.length} GitHub Actions ${failed.length === 1 ? "run" : "runs"} on ${head}.` };
}

/**
 * How a failed GitHub write ended: at a rate limit; unclear, so it may have landed (a timeout, a dropped connection,
 * a server error) or the facts it was confirmed on moved; or refused.
 */
export function writeFailure(error: string): "rate-limited" | "unclear" | "refused" {
  if (githubRateLimit(error)) return "rate-limited";
  return error.includes(HEAD_MOVED) || /stopped before it finished|timed? ?out|deadline exceeded|connection (?:reset|refused|closed)|socket hang up|unexpected EOF|HTTP 50[0234]|bad gateway|service unavailable|could not resolve host/iu.test(error)
    ? "unclear" : "refused";
}

/** How a failed GitHub read hit a rate limit: the primary limit, whose reset GitHub reports, or a secondary limit, which names none. */
export function githubRateLimit(error: string): "primary" | "secondary" | null {
  if (/secondary rate limit|abuse detection/iu.test(error)) return "secondary";
  return /rate limit/iu.test(error) ? "primary" : null;
}

/**
 * When GitHub's exhausted primary limits reset, in epoch ms, from `gh api rate_limit`, which doesn't count against
 * them. Null when none is exhausted or the read failed.
 */
export async function readRateLimitReset(run: GhRunner): Promise<number | null> {
  const result = await run(["api", "rate_limit"]);
  if (!result.ok) return null;
  let resources: unknown;
  try { resources = (JSON.parse(result.stdout) as { resources?: unknown }).resources; } catch { return null; }
  if (typeof resources !== "object" || resources === null) return null;
  const resets = Object.values(resources).flatMap((limit: { remaining?: unknown; reset?: unknown }) =>
    limit?.remaining === 0 && typeof limit.reset === "number" ? [limit.reset * 1_000] : []);
  return resets.length ? Math.max(...resets) : null;
}
