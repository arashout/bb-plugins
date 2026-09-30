import { describe, expect, it, vi } from "vitest";
import type { Pr, PrWrite } from "./contract.js";
import { parsePrList } from "./gh.js";
import { createInventoryActions, suggestReviewers, type ActionRecord, type InventoryActionDeps } from "./inventory-actions.js";
import { attentionReasons, DEFAULT_ATTENTION_THRESHOLDS, type AttentionReason } from "./pr-attention.js";
import type { PrHold } from "./pr-holds.js";
import type { ApprovalEvidence } from "./approval-evidence.js";

const URL = "https://github.com/inkwell/folio/pull/42";
const HEAD = "a".repeat(40);
const pr = (extra: Record<string, unknown> = {}): Pr => parsePrList(JSON.stringify([{ number: 42, url: URL, state: "OPEN", title: "ABC-42 Keep shelf order",
  isDraft: false, reviewDecision: "REVIEW_REQUIRED", headRefOid: HEAD, latestReviews: [], reviewRequests: [], statusCheckRollup: [], ...extra }]))!.pr;
const waiting = (reviewers: string[]): AttentionReason => ({ question: "needs-nudge", kind: "review-waiting", action: "nudge", nextStep: "Nudge", owner: "reviewers",
  reviewers, since: 0, ageMs: 0, basis: "github" });

// Approval comments on the head the row showed, not yet verified there, on a PR otherwise ready: approved, green, clean, threads resolved.
const FEEDBACK = { status: "present" as const, fingerprint: "f".repeat(64), sourceIds: ["review-1"] };
const commented = (extra: Partial<Pr> = {}): Pr => ({ ...pr({ reviewDecision: "APPROVED" }), checkConclusions: ["SUCCESS"], mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN", unresolvedReviewThreads: 0, resolvedReviewThreads: 1, approvalFeedback: FEEDBACK, approvalFeedbackVerified: false, ...extra });
/** The inventory's own rule, so a confirmation is re-checked on the facts that earned its row's reason. */
const earned: InventoryActionDeps["attention"] = async (facts) => attentionReasons(facts, {}, { now: 1_000, thresholds: DEFAULT_ATTENTION_THRESHOLDS,
  utcOffsetMinutes: 0 });

/** The live case that read as ready: the note is in the approval's review body, with no thread, reply, or commit after it. */
const NONE: ApprovalEvidence = { since: "2026-09-28T12:00:00Z", commits: 0, replies: 0, threads: { total: 0, resolved: 0 }, complete: true };

/** Doubles for every dependency, each overridable; `log` records the order reads and writes happen in. */
function setup(options: { listed?: boolean; fresh?: Pr | null; evidence?: ApprovalEvidence; deps?: Partial<InventoryActionDeps> } = {}) {
  const log: string[] = [];
  const records: ActionRecord[] = [];
  const writes: PrWrite[] = [];
  const confirmed: unknown[][] = [];
  let hold: PrHold | null = null, writer: string | null = null, effortHold: string | null = null, locked = false;
  const { listed = true, fresh = pr() } = options;
  const deps: InventoryActionDeps = {
    now: () => 1_000,
    listed: () => listed,
    hold: () => hold,
    effortHold: async () => effortHold,
    writer: () => writer,
    lock: () => { if (locked) return null; locked = true; return () => { locked = false; }; },
    read: vi.fn(async () => { log.push("read"); return { ok: true as const, pr: fresh }; }),
    attention: async (facts) => facts.reviewRequests.length ? [waiting([...facts.reviewRequests])] : [],
    write: vi.fn(async (request: PrWrite) => { log.push("write"); writes.push(request); return { ok: true as const, detail: "Done." }; }),
    handling: async () => { log.push("notes"); return { ok: true as const, headOid: HEAD, fingerprint: FEEDBACK.fingerprint, sources: [], evidence: options.evidence ?? NONE }; },
    confirm: (...args) => { log.push("confirm"); confirmed.push(args); },
    record: async (entry) => { records.push(entry); },
    ...options.deps,
  };
  return { actions: createInventoryActions(deps), deps, log, records, writes, confirmed,
    hold: (value: PrHold | null) => { hold = value; }, writer: (value: string | null) => { writer = value; },
    effortHold: (value: string | null) => { effortHold = value; }, lock: () => { locked = true; } };
}

describe("inventory actions", () => {
  const draft = pr({ isDraft: true });
  it("writes only after reading the PR again, on the head the row showed, reads it back, and records what it did", async () => {
    const env = setup({ fresh: draft });
    expect(await env.actions.markReady(URL, HEAD)).toEqual({ ok: true, detail: "Done." });
    expect(env.log).toEqual(["read", "write", "read"]);
    expect(env.writes).toEqual([{ kind: "ready", prUrl: URL, headOid: HEAD }]);
    expect(env.records).toEqual([{ at: 1_000, prUrl: URL, action: "mark-ready", ok: true, detail: "Done.", reviewers: [] }]);
  });

  it("refuses under a hold, a v2 claim, or another action without reading or writing, and records the refusal", async () => {
    const held = setup({ fresh: draft });
    held.hold({ reason: "Store layout first", heldAt: 0 });
    expect(await held.actions.markReady(URL, HEAD)).toEqual({ ok: false, error: "On hold: Store layout first. Release the hold first; nothing was written." });
    const claimed = setup({ fresh: draft });
    claimed.writer("A worker from the Shelf order roster is writing this PR or checkout.");
    expect(await claimed.actions.markReady(URL, HEAD)).toMatchObject({ ok: false, error: expect.stringContaining("Shelf order roster") });
    // Holding its effort holds the PR too, as the Hold dialog promises.
    const effortHeld = setup({ fresh: draft });
    effortHeld.effortHold("Its effort is on hold. Resume it first; nothing was written.");
    expect(await effortHeld.actions.markReady(URL, HEAD)).toEqual({ ok: false, error: "Its effort is on hold. Resume it first; nothing was written." });
    const busy = setup({ fresh: draft });
    busy.lock();
    expect(await busy.actions.markReady(URL, HEAD)).toMatchObject({ ok: false, error: expect.stringContaining("Another action") });
    for (const env of [held, claimed, effortHeld, busy]) {
      expect(env.log).toEqual([]);
      expect(env.records).toMatchObject([{ action: "mark-ready", ok: false }]);
    }
    // Only one of your open PRs: a PR the inventory doesn't show is no click's to authorize.
    const unknown = setup({ listed: false, fresh: draft });
    expect(await unknown.actions.markReady(URL, HEAD)).toMatchObject({ ok: false, error: expect.stringContaining("isn't one of your open PRs") });
  });

  it("refuses a hold or a claim that lands while GitHub answers", async () => {
    const env = setup({ fresh: draft });
    (env.deps.read as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      env.log.push("read");
      env.writer("A worker from the Shelf order roster is writing this PR or checkout.");
      return { ok: true, pr: draft };
    });
    expect(await env.actions.markReady(URL, HEAD)).toMatchObject({ ok: false, error: expect.stringContaining("Shelf order roster") });
    expect(env.log).toEqual(["read"]);
    const effortHeld = setup({ fresh: draft });
    (effortHeld.deps.read as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      effortHeld.log.push("read");
      effortHeld.effortHold("Its effort is on hold. Resume it first; nothing was written.");
      return { ok: true, pr: draft };
    });
    expect(await effortHeld.actions.markReady(URL, HEAD)).toMatchObject({ ok: false, error: expect.stringContaining("Its effort is on hold") });
    expect(effortHeld.log).toEqual(["read"]);
  });

  it("refuses to mark ready when the facts it rests on changed from the row's: a new head, no longer a draft, closed, or unread", async () => {
    for (const [fresh, error] of [[pr({ isDraft: true, headRefOid: "b".repeat(40) }), "New commits landed"], [pr(), "no longer a draft"],
      [null, "no longer open"]] as const) {
      const env = setup({ fresh });
      expect(await env.actions.markReady(URL, HEAD)).toMatchObject({ ok: false, error: expect.stringContaining(error) });
      expect(env.writes).toEqual([]);
    }
    const unread = setup({ deps: { read: async () => ({ ok: false, error: "HTTP 502" }) } });
    expect(await unread.actions.markReady(URL, HEAD)).toEqual({ ok: false, error: "GitHub couldn't be read, so nothing was written: HTTP 502" });
  });

  it("requests review only from logins, only while the PR's reviewers stand as its row showed them, and never asks anyone twice", async () => {
    const asked = pr({ reviewRequests: [{ login: "mira" }] });
    const shown = { requested: ["mira"], reviewed: [] };
    const env = setup({ fresh: asked });
    expect(await env.actions.requestReview(URL, ["Mira", "otto"], shown)).toMatchObject({ ok: true });
    expect(env.writes).toEqual([{ kind: "nudge", prUrl: URL, reviewers: ["otto"], comment: null }]);
    expect(env.records).toMatchObject([{ action: "request-review", ok: true, reviewers: ["otto"] }]);
    expect(await setup({ fresh: asked }).actions.requestReview(URL, ["mira"], shown)).toMatchObject({ ok: false, error: "@mira is already asked; nothing was written." });
    expect(await setup().actions.requestReview(URL, ["--admin"], { requested: [], reviewed: [] }))
      .toMatchObject({ ok: false, error: expect.stringContaining("not a login: --admin") });
    // Someone else asked, or someone reviewed, since the row was shown.
    for (const fresh of [pr({ reviewRequests: [{ login: "lena" }] }), pr({ latestReviews: [{ author: { login: "lena" }, state: "COMMENTED" }] })]) {
      const changed = setup({ fresh });
      expect(await changed.actions.requestReview(URL, ["otto"], { requested: [], reviewed: [] }))
        .toMatchObject({ ok: false, error: expect.stringContaining("reviewers changed") });
      expect(changed.writes).toEqual([]);
    }
  });

  it("nudges exactly the reviewers the row named, and only while fresh facts name the same ones", async () => {
    const env = setup({ fresh: pr({ reviewRequests: [{ login: "mira" }] }) });
    expect(await env.actions.nudge(URL, ["mira"])).toMatchObject({ ok: true });
    expect(env.writes).toEqual([{ kind: "nudge", prUrl: URL, reviewers: ["mira"], comment: null }]);
    const moved = setup({ fresh: pr({ reviewRequests: [{ login: "mira" }, { login: "otto" }] }) });
    expect(await moved.actions.nudge(URL, ["mira"])).toMatchObject({ ok: false, error: expect.stringContaining("now @mira, @otto") });
    const answered = setup({ fresh: pr() });
    expect(await answered.actions.nudge(URL, ["mira"])).toEqual({ ok: false, error: "No reviewer needs a nudge now; nothing was written." });
    expect([...moved.writes, ...answered.writes]).toEqual([]);
  });

  // Confirming clears the merge gate, so it must bind to exactly what the row showed and never stand in for a newer push or comment.
  it("confirms an approval's comments on the head and comments the row showed, as yours, writing nothing to GitHub", async () => {
    const replied = { ...NONE, replies: 1 };
    const env = setup({ fresh: commented(), evidence: replied, deps: { attention: earned } });
    const detail = "Confirmed the approval's comments handled on aaaaaaa: 1 reply since this approval.";
    expect(await env.actions.confirmHandled(URL, HEAD, FEEDBACK.fingerprint)).toEqual({ ok: true, detail });
    expect(env.log).toEqual(["read", "notes", "confirm"]);
    expect(env.confirmed).toEqual([[URL, HEAD, FEEDBACK, replied]]);
    expect(env.writes).toEqual([]);
    expect(env.records).toEqual([{ at: 1_000, prUrl: URL, action: "confirm-handled", ok: true, detail, reviewers: [] }]);
  });

  // The false readiness this guards against: one click recorded "handled" on a note nobody answered, and the PR read as ready to merge.
  it("never confirms in one click without evidence, and confirming anyway records that there was none", async () => {
    const env = setup({ fresh: commented(), deps: { attention: earned } });
    expect(await env.actions.confirmHandled(URL, HEAD, FEEDBACK.fingerprint)).toEqual({ ok: false,
      error: "No commits, reply, or resolved threads since this approval. Ask its thread to address it, or confirm anyway; nothing was written." });
    expect(env.confirmed).toEqual([]);
    expect(await env.actions.confirmHandled(URL, HEAD, FEEDBACK.fingerprint, true)).toEqual({ ok: true,
      detail: "Confirmed the approval's comments handled on aaaaaaa without evidence: no commits, reply, or resolved threads since this approval." });
    expect(env.confirmed).toEqual([[URL, HEAD, FEEDBACK, NONE]]);
    // A read GitHub cut short is no evidence either.
    const cut = setup({ fresh: commented(), evidence: { ...NONE, commits: 3, complete: false }, deps: { attention: earned } });
    expect(await cut.actions.confirmHandled(URL, HEAD, FEEDBACK.fingerprint)).toMatchObject({ ok: false, error: expect.stringContaining("cut short") });
    expect(cut.confirmed).toEqual([]);
  });

  it("confirms in one click on each kind of evidence: a commit, an author's reply, or the approval's threads resolved", async () => {
    for (const evidence of [{ ...NONE, commits: 1 }, { ...NONE, replies: 1 }, { ...NONE, threads: { total: 2, resolved: 2 } }]) {
      const env = setup({ fresh: commented(), evidence, deps: { attention: earned } });
      expect(await env.actions.confirmHandled(URL, HEAD, FEEDBACK.fingerprint)).toMatchObject({ ok: true });
      expect(env.confirmed).toEqual([[URL, HEAD, FEEDBACK, evidence]]);
    }
    const open = setup({ fresh: commented(), evidence: { ...NONE, threads: { total: 2, resolved: 1 } }, deps: { attention: earned } });
    expect(await open.actions.confirmHandled(URL, HEAD, FEEDBACK.fingerprint)).toMatchObject({ ok: false });
  });

  it("refuses to confirm on notes it couldn't read, or read on another head or feedback than the row's", async () => {
    const failed = setup({ fresh: commented(), deps: { attention: earned, handling: async () => ({ ok: false, error: "HTTP 502" }) } });
    expect(await failed.actions.confirmHandled(URL, HEAD, FEEDBACK.fingerprint, true)).toEqual({ ok: false,
      error: "GitHub couldn't be read for the approval's notes, so nothing was written: HTTP 502" });
    const moved = setup({ fresh: commented(), deps: { attention: earned, handling: async () => ({ ok: true, headOid: "b".repeat(40),
      fingerprint: FEEDBACK.fingerprint, sources: [], evidence: { ...NONE, commits: 1 } }) } });
    expect(await moved.actions.confirmHandled(URL, HEAD, FEEDBACK.fingerprint)).toMatchObject({ ok: false, error: expect.stringContaining("changed while they were read") });
    expect([...failed.confirmed, ...moved.confirmed]).toEqual([]);
  });

  it("refuses to confirm under a hold or a v2 claim, or once the head, the comments, their verification, or what else the row showed moved", async () => {
    const held = setup({ fresh: commented() });
    held.hold({ reason: "Store layout first", heldAt: 0 });
    expect(await held.actions.confirmHandled(URL, HEAD, FEEDBACK.fingerprint)).toEqual({ ok: false,
      error: "On hold: Store layout first. Release the hold first; nothing was written." });
    const claimed = setup({ fresh: commented() });
    claimed.writer("A worker from the Shelf order roster is writing this PR or checkout. Nothing was written.");
    expect(await claimed.actions.confirmHandled(URL, HEAD, FEEDBACK.fingerprint)).toMatchObject({ ok: false, error: expect.stringContaining("Shelf order roster") });
    for (const env of [held, claimed]) expect(env.log).toEqual([]);
    const moved: [Pr, string][] = [
      [commented({ headRefOid: "b".repeat(40) }), "New commits landed since the row was shown. Review them and try again; nothing was written."],
      [commented({ approvalFeedback: { ...FEEDBACK, fingerprint: "e".repeat(64), sourceIds: ["review-1", "review-2"] } }),
        "The approval's comments changed since the row was shown. Read them and try again; nothing was written."],
      [commented({ approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] }, approvalFeedbackVerified: true }),
        "The approval has no comments to confirm now; nothing was written."],
      [commented({ approvalFeedback: { status: "unknown", fingerprint: null, sourceIds: [] } }),
        "GitHub didn't return the approval's comments in full. Refresh and try again; nothing was written."],
      // A worker's evidence for this head already clears it; your confirmation would overwrite that evidence.
      [commented({ approvalFeedbackVerified: true }), "These comments are already verified on this head; nothing was written."],
      // The same comments, but the approver reopened a thread or asked for changes, or the PR went red or conflicting: they aren't handled.
      ...[{ unresolvedReviewThreads: 1 }, { reviewDecision: "CHANGES_REQUESTED" }, { checkConclusions: ["FAILURE"] }, { mergeStateStatus: "DIRTY" as const }]
        .map((extra): [Pr, string] => [commented(extra),
          "Its approval, checks, merge state, or review threads changed since the row was shown. Review it and try again; nothing was written."]),
    ];
    for (const [fresh, error] of moved) {
      const env = setup({ fresh, deps: { attention: earned } });
      expect(await env.actions.confirmHandled(URL, HEAD, FEEDBACK.fingerprint)).toEqual({ ok: false, error });
      expect(env.log).toEqual(["read"]);
      expect(env.records).toMatchObject([{ action: "confirm-handled", ok: false, detail: error }]);
    }
  });

  it("records a write GitHub refused, and doesn't read back what didn't change", async () => {
    const env = setup({ fresh: draft, deps: { write: async () => ({ ok: false, error: "GitHub refused to mark the PR ready: HTTP 422" }) } });
    expect(await env.actions.markReady(URL, HEAD)).toEqual({ ok: false, error: "GitHub refused to mark the PR ready: HTTP 422" });
    expect(env.log).toEqual(["read"]);
    expect(env.records).toMatchObject([{ ok: false, detail: "GitHub refused to mark the PR ready: HTTP 422" }]);
  });
});

describe("suggested reviewers", () => {
  const review = (login: string, submittedAt: string, state = "APPROVED") => ({ login, state, submittedAt });
  it("suggests this PR's past reviewers first, then the repository's most recent, leaving out anyone already asked", () => {
    const current = { reviewRequests: ["otto"], latestReviews: [review("lena", "2026-09-01T00:00:00Z", "COMMENTED"), review("pending", "2026-09-27T00:00:00Z", "PENDING")] };
    const repository = [
      { latestReviews: [review("mira", "2026-09-20T00:00:00Z"), review("Otto", "2026-09-27T00:00:00Z")] },
      { latestReviews: [review("ines", "2026-09-26T00:00:00Z"), review("LENA", "2026-09-25T00:00:00Z"), review("--admin", "2026-09-28T00:00:00Z")] },
    ];
    expect(suggestReviewers(current, repository)).toEqual(["lena", "ines", "mira"]);
    expect(suggestReviewers(current, repository, 2)).toEqual(["lena", "ines"]);
  });
});
