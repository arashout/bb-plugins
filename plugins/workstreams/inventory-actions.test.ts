import { describe, expect, it, vi } from "vitest";
import type { Pr, PrWrite } from "./contract.js";
import { parsePrList } from "./gh.js";
import { createInventoryActions, suggestReviewers, type ActionRecord, type InventoryActionDeps } from "./inventory-actions.js";
import type { AttentionReason } from "./pr-attention.js";
import type { PrHold } from "./pr-holds.js";

const URL = "https://github.com/inkwell/folio/pull/42";
const HEAD = "a".repeat(40);
const pr = (extra: Record<string, unknown> = {}): Pr => parsePrList(JSON.stringify([{ number: 42, url: URL, state: "OPEN", title: "ABC-42 Keep shelf order",
  isDraft: false, reviewDecision: "REVIEW_REQUIRED", headRefOid: HEAD, latestReviews: [], reviewRequests: [], statusCheckRollup: [], ...extra }]))!.pr;
const waiting = (reviewers: string[]): AttentionReason => ({ question: "needs-nudge", kind: "review-waiting", action: "nudge", nextStep: "Nudge", owner: "reviewers",
  reviewers, since: 0, ageMs: 0, basis: "github" });

/** Doubles for every dependency, each overridable; `log` records the order reads and writes happen in. */
function setup(options: { listed?: boolean; fresh?: Pr | null; deps?: Partial<InventoryActionDeps> } = {}) {
  const log: string[] = [];
  const records: ActionRecord[] = [];
  const writes: PrWrite[] = [];
  let hold: PrHold | null = null, writer: string | null = null, locked = false;
  const { listed = true, fresh = pr() } = options;
  const deps: InventoryActionDeps = {
    now: () => 1_000,
    listed: () => listed,
    hold: () => hold,
    writer: () => writer,
    lock: () => { if (locked) return null; locked = true; return () => { locked = false; }; },
    read: vi.fn(async () => { log.push("read"); return { ok: true as const, pr: fresh }; }),
    attention: async (facts) => facts.reviewRequests.length ? [waiting([...facts.reviewRequests])] : [],
    write: vi.fn(async (request: PrWrite) => { log.push("write"); writes.push(request); return { ok: true as const, detail: "Done." }; }),
    record: async (entry) => { records.push(entry); },
    ...options.deps,
  };
  return { actions: createInventoryActions(deps), deps, log, records, writes,
    hold: (value: PrHold | null) => { hold = value; }, writer: (value: string | null) => { writer = value; }, lock: () => { locked = true; } };
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
    const busy = setup({ fresh: draft });
    busy.lock();
    expect(await busy.actions.markReady(URL, HEAD)).toMatchObject({ ok: false, error: expect.stringContaining("Another action") });
    for (const env of [held, claimed, busy]) {
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
