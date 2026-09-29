// The PR inventory's one-click actions: mark a draft ready, request review,
// nudge the reviewers attention names, and confirm an approval's comments
// handled. Each click authorizes one write on the facts the row showed, which
// the click sends back: a GitHub write, or for a confirmation, a verification
// recorded as yours. Before writing, it reads the PR again, and it refuses
// under a hold (the PR's or its effort's), a v2 claim or another writer, and
// when the facts the step depends on changed since the row was shown. Every
// outcome is recorded, refusals included. Merge is not here: the row opens the
// existing fresh merge preview, and nothing merges outside it.
import type { ApprovalFeedbackSnapshot } from "./approval-feedback.js";
import type { Pr, PrWrite } from "./contract.js";
import { REVIEWER } from "./ghactions.js";
import type { AttentionReason } from "./pr-attention.js";
import type { PrHold } from "./pr-holds.js";

export type InventoryAction = "mark-ready" | "request-review" | "nudge" | "confirm-handled";
export type ActionResult = { ok: true; detail: string } | { ok: false; error: string };
export type ActionRecord = { at: number; prUrl: string; action: InventoryAction; ok: boolean; detail: string; reviewers: string[] };
/** The reviewers a row showed: those asked, and those who reviewed, with their latest review's state. */
export type ShownReviewers = { requested: readonly string[]; reviewed: readonly { login: string; state: string }[] };

export type InventoryActionDeps = {
  now(): number;
  /** Whether the PR is one of your open PRs in the inventory. */
  listed(prUrl: string): boolean;
  hold(prUrl: string): PrHold | null;
  /** Why the PR's effort stops it: you put the effort on hold, completed it, or archived it, until you resume, reopen, or restore it. Null otherwise. */
  effortHold(prUrl: string): Promise<string | null>;
  /** Why another writer holds the PR or a checkout of it (a v2 claim, a legacy batch, a launching board action), or null. */
  writer(prUrl: string): string | null;
  /** Take the PR's board-action lock, or null when another action holds it; the result releases it. */
  lock(prUrl: string): (() => void) | null;
  /** Read the PR from GitHub now, through the board's stores, as they keep it (ages a failed dates read left out carried): null once it isn't open. */
  read(prUrl: string): Promise<{ ok: true; pr: Pr | null } | { ok: false; error: string }>;
  /** The attention these facts earn, as the inventory computes it. */
  attention(pr: Pr): Promise<readonly AttentionReason[]>;
  write(request: PrWrite): Promise<ActionResult>;
  /** Record your verification of this approval feedback on this head, with your provenance. */
  confirm(prUrl: string, headOid: string, feedback: ApprovalFeedbackSnapshot): void;
  record(entry: ActionRecord): Promise<void>;
};

type Step = { write: PrWrite; reviewers?: string[] } | { confirm: { headOid: string; feedback: ApprovalFeedbackSnapshot } } | { refuse: string };
const logins = (values: readonly string[]) => [...new Set(values.map((login) => login.toLowerCase()))].sort().join(", ");
const mentions = (values: readonly string[]) => values.map((login) => `@${login}`).join(", ");
/** Who a nudge re-requests: every reviewer an overdue request or an answered change request names. */
const nudged = (reasons: readonly AttentionReason[]) =>
  [...new Set(reasons.filter((reason) => reason.action === "nudge" || reason.action === "rerequest").flatMap((reason) => reason.reviewers))];

/**
 * Reviewers to ask, best first: those who already reviewed this PR, then those who most recently reviewed another PR in its repository,
 * as the board's reads observed them. Anyone already asked is left out.
 */
export function suggestReviewers(pr: Pick<Pr, "latestReviews" | "reviewRequests">, repository: readonly Pick<Pr, "latestReviews">[], limit = 5): string[] {
  const asked = new Set(pr.reviewRequests.map((login) => login.toLowerCase()));
  const recent = repository.flatMap((other) => other.latestReviews.filter((review) => review.state !== "PENDING"))
    .sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""));
  const seen = new Set<string>();
  return [...pr.latestReviews.filter((review) => review.state !== "PENDING"), ...recent].flatMap(({ login }) => {
    const key = login.toLowerCase();
    if (asked.has(key) || seen.has(key) || !REVIEWER.test(login)) return [];
    seen.add(key);
    return [login];
  }).slice(0, limit);
}

export function createInventoryActions(deps: InventoryActionDeps) {
  const heldOrClaimed = (prUrl: string): string | null => {
    const hold = deps.hold(prUrl);
    return hold ? `On hold${hold.reason ? `: ${hold.reason}` : ""}. Release the hold first; nothing was written.` : deps.writer(prUrl);
  };
  /** One authorized write: guard, lock, read again, re-guard, decide on the fresh facts against the row's, write, read back, and record the outcome. */
  async function act(action: InventoryAction, prUrl: string, decide: (fresh: Pr) => Step | Promise<Step>): Promise<ActionResult> {
    const finish = async (result: ActionResult, reviewers: string[] = []) => {
      await deps.record({ at: deps.now(), prUrl, action, ok: result.ok, detail: result.ok ? result.detail : result.error, reviewers });
      return result;
    };
    const refuse = (error: string) => finish({ ok: false, error });
    if (!deps.listed(prUrl)) return refuse("That PR isn't one of your open PRs in the inventory. Refresh it and try again.");
    const guarded = heldOrClaimed(prUrl) ?? await deps.effortHold(prUrl);
    if (guarded) return refuse(guarded);
    const release = deps.lock(prUrl);
    if (!release) return refuse("Another action on this PR is still running; nothing was written.");
    try {
      const read = await deps.read(prUrl);
      if (!read.ok) return refuse(`GitHub couldn't be read, so nothing was written: ${read.error}`);
      if (!read.pr) return refuse("This PR is no longer open; nothing was written.");
      // A hold or a claim may have landed while GitHub answered.
      const late = heldOrClaimed(prUrl) ?? await deps.effortHold(prUrl);
      if (late) return refuse(late);
      const step = await decide(read.pr);
      if ("refuse" in step) return refuse(step.refuse);
      // GitHub doesn't change, so there's nothing to read back.
      if ("confirm" in step) {
        deps.confirm(prUrl, step.confirm.headOid, step.confirm.feedback);
        return finish({ ok: true, detail: `Confirmed the approval's comments handled on ${step.confirm.headOid.slice(0, 7)}.` });
      }
      const result = await deps.write(step.write);
      // Read it once more so its row shows what the write did.
      if (result.ok) await deps.read(prUrl);
      return finish(result, step.reviewers);
    } finally { release(); }
  }
  return {
    /** Only a draft, on the head its row showed; the host checks the head once more as it writes. */
    markReady: (prUrl: string, headOid: string) => act("mark-ready", prUrl, (fresh) => {
      if (!fresh.isDraft) return { refuse: "It's no longer a draft; nothing was written." };
      if (fresh.headRefOid !== headOid) return { refuse: "New commits landed since the row was shown. Review it and try again; nothing was written." };
      return { write: { kind: "ready", prUrl, headOid } };
    }),
    /** Ask these reviewers, while the PR's reviewers stand as its row showed them. Anyone already asked is skipped. */
    requestReview: (prUrl: string, requested: readonly string[], shown: ShownReviewers) => act("request-review", prUrl, (fresh) => {
      const invalid = requested.filter((login) => !REVIEWER.test(login));
      if (requested.length === 0 || invalid.length) return { refuse: `Choose reviewers by GitHub login${invalid.length ? `; not a login: ${invalid.join(", ")}` : ""}.` };
      const reviewed = (reviews: ShownReviewers["reviewed"]) =>
        logins(reviews.filter((review) => review.state !== "PENDING").map((review) => `${review.login}:${review.state}`));
      if (logins(fresh.reviewRequests) !== logins(shown.requested) || reviewed(fresh.latestReviews) !== reviewed(shown.reviewed)) {
        return { refuse: `Its reviewers changed since the row was shown (now requested: ${mentions(fresh.reviewRequests) || "no one"}). Review it and try again; nothing was written.` };
      }
      const asked = new Set(fresh.reviewRequests.map((login) => login.toLowerCase()));
      const reviewers = [...new Set(requested)].filter((login) => !asked.has(login.toLowerCase()));
      if (reviewers.length === 0) return { refuse: `${mentions(requested)} ${requested.length === 1 ? "is" : "are"} already asked; nothing was written.` };
      return { write: { kind: "nudge", prUrl, reviewers, comment: null }, reviewers };
    }),
    /** Re-request exactly the reviewers the row's nudge named, and only while fresh facts name the same ones. */
    nudge: (prUrl: string, shown: readonly string[]) => act("nudge", prUrl, async (fresh) => {
      const after = nudged(await deps.attention(fresh));
      if (after.length === 0) return { refuse: "No reviewer needs a nudge now; nothing was written." };
      if (logins(shown) !== logins(after)) return { refuse: `Who needs a nudge changed since the row was shown (now ${mentions(after)}). Review it and try again; nothing was written.` };
      return { write: { kind: "nudge", prUrl, reviewers: after, comment: null }, reviewers: after };
    }),
    /** Record the approval's comments handled, bound to the head and feedback the row showed, and only while fresh facts still ask for it. */
    confirmHandled: (prUrl: string, headOid: string, fingerprint: string) => act("confirm-handled", prUrl, async (fresh) => {
      if (fresh.headRefOid !== headOid) return { refuse: "New commits landed since the row was shown. Review them and try again; nothing was written." };
      const feedback = fresh.approvalFeedback;
      if (feedback?.status !== "present") return { refuse: feedback?.status === "none" ? "The approval has no comments to confirm now; nothing was written."
        : "GitHub didn't return the approval's comments in full. Refresh and try again; nothing was written." };
      if (feedback.fingerprint !== fingerprint) return { refuse: "The approval's comments changed since the row was shown. Read them and try again; nothing was written." };
      if (fresh.approvalFeedbackVerified === true) return { refuse: "These comments are already verified on this head; nothing was written." };
      // The rest of what earned the row's reason: approved, green, merge-clean, and every review thread resolved. An approver who reopened a
      // thread leaves the fingerprint as it was, but not this.
      if (!(await deps.attention(fresh)).some((reason) => reason.kind === "approval-comments")) {
        return { refuse: "Its approval, checks, merge state, or review threads changed since the row was shown. Review it and try again; nothing was written." };
      }
      return { confirm: { headOid, feedback } };
    }),
  };
}
