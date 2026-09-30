import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeckBatches, DECK_BATCH_MIGRATION, planBatch, type PlanRow } from "./deck-batch.js";
import type { DeckSection } from "./deck-shared.js";

const HEAD = "c".repeat(40);
let next = 600;
const row = (section: DeckSection, patch: Partial<PlanRow["row"]> = {}, facts: Partial<Omit<PlanRow, "row">> = {}): PlanRow => {
  const number = next++;
  return { row: { prUrl: `https://github.com/inkwell/quill/pull/${number}`, repo: "inkwell/quill", number, title: `ABC-${number} Print hold slips`, section,
    suggested: ["kai"], nudge: section === "nudge" ? ["mira"] : [], notes: section === "confirm" ? 1 : 0, acted: null, hold: null, ...patch },
  pile: "active", head: HEAD, fingerprint: section === "confirm" ? "f".repeat(64) : null, shown: { requested: [], reviewed: [{ login: "otto", state: "COMMENTED" }] },
  ...facts };
};
const brief = (plan: ReturnType<typeof planBatch>) => ({ items: plan.items.map((item) => `${item.kind} ${item.ref}: ${item.what}`),
  skipped: plan.skipped.map((skip) => `${skip.ref}: ${skip.reason}`) });

describe("planning a deck batch", () => {
  it("plans Advance as every safe move in the effort, nudge through mark ready, and leaves merges and a thread's work to their own paths", () => {
    next = 600;
    const rows = [row("ready"), row("merge"), row("request"), row("work"), row("nudge"), row("confirm"), row("flight"), row("blocked")];
    expect(brief(planBatch("advance", rows, { selected: false }))).toEqual({ items: [
      "nudge quill #604: Nudge @mira", "request quill #602: Request @kai", "ready quill #600: Mark ready"], skipped: [] });
  });

  // A batched confirmation once read a PR ready to merge though nobody had answered its approval's note: notes are confirmed one PR at a
  // time, after reading them, so no Advance, row Advance, or selection ever carries one.
  it("never plans a confirmation of review notes, in Advance, on a row's own Advance, or in a selection", () => {
    next = 605;
    const confirm = row("confirm");
    expect(brief(planBatch("advance", [confirm], { selected: false }))).toEqual({ items: [], skipped: [] });
    expect(brief(planBatch("advance", [confirm], { selected: true }))).toEqual({ items: [], skipped: ["quill #605: Its review notes are confirmed from its own row."] });
    expect(brief(planBatch("nudge", [confirm, row("nudge")], { selected: true })).items).toEqual(["nudge quill #606: Nudge @mira"]);
  });

  it("asks the reviewers you pick on every PR in a request, and keeps what each row showed so the request can check it", () => {
    next = 610;
    const plan = planBatch("request", [row("request"), row("request", { suggested: [] })], { selected: false, reviewers: ["dana", "lee"] });
    expect(plan.items.map((item) => [item.ref, item.reviewers, item.shown])).toEqual([
      ["quill #610", ["dana", "lee"], { requested: [], reviewed: [{ login: "otto", state: "COMMENTED" }] }],
      ["quill #611", ["dana", "lee"], { requested: [], reviewed: [{ login: "otto", state: "COMMENTED" }] }]]);
  });

  it("names why each selected PR can't take the write, so the confirm lists what won't happen as well as what will", () => {
    next = 620;
    const rows = [row("nudge"), row("nudge", {}, { pile: "held" }), row("nudge", {}, { pile: "done" }), row("merge"),
      row("nudge", { acted: { kind: "nudge", state: "queued", at: 1, batchId: "b" } }), row("blocked", { hold: { reason: "Counter redesign", since: 1 } }),
      row("request", { suggested: [] }), row("ready", {}, { head: null }), row("nudge", { nudge: [] })];
    expect(brief(planBatch("advance", rows, { selected: true }))).toEqual({ items: ["nudge quill #620: Nudge @mira"], skipped: [
      "quill #621: Its effort is on hold.", "quill #622: Its effort is done.", "quill #623: Merges go through the merge preview.",
      "quill #624: A write on it is waiting or just ran.", "quill #625: On hold. Release it first.", "quill #626: No reviewer to suggest. Pick one.",
      "quill #627: Not read in full yet. Refresh it first.", "quill #628: No reviewer needs a nudge now."] });
    // A selection for one kind names the move a row needs instead.
    expect(brief(planBatch("ready", [row("nudge")], { selected: true })).skipped).toEqual(["quill #629: Its next move is a nudge."]);
  });

});

describe("planning an ask", () => {
  // The confirm's answer to notes nobody answered: the PR's thread is asked, through the listing and its Undo window, and nothing is confirmed.
  it("asks the thread of each chosen PR whose next move is its notes, bound to the head and notes it showed, and never in Advance", () => {
    next = 690;
    const rows = [row("confirm", { notes: 2 }), row("nudge"), row("confirm", { hold: { reason: "Counter redesign", since: 1 } }), row("confirm", {}, { fingerprint: null }),
      row("confirm", { acted: { kind: "ask", state: "queued", at: 1, batchId: "b" } }), row("confirm", {}, { pile: "held" })];
    expect(brief(planBatch("ask", rows, { selected: true }))).toEqual({ items: ["ask quill #690: Ask its thread to address 2 notes"], skipped: [
      "quill #691: Its approval has no notes waiting.", "quill #692: On hold. Release it first.", "quill #693: Not read in full yet. Refresh it first.",
      "quill #694: A write on it is waiting or just ran.", "quill #695: Its effort is on hold."] });
    expect(planBatch("ask", rows.slice(0, 1), { selected: true }).items[0]).toMatchObject({ headOid: HEAD, fingerprint: "f".repeat(64), notes: 2 });
    expect(brief(planBatch("advance", rows, { selected: false })).items).toEqual(["nudge quill #691: Nudge @mira"]);
  });

  it("names where the ask goes, and leaves the PR out with why when it can go nowhere yet", () => {
    next = 700;
    const plan = (ask: { to: string } | { why: string }) => brief(planBatch("ask", [row("confirm", {}, { ask })], { selected: true }));
    expect(plan({ to: "Start a thread under Counter redesign" }).items).toEqual(["ask quill #700: Start a thread under Counter redesign to address 1 note"]);
    expect(plan({ why: "This PR has no thread, and nothing to start one under yet." })).toEqual({ items: [],
      skipped: ["quill #701: This PR has no thread, and nothing to start one under yet."] });
  });
});

describe("planning a release", () => {
  it("lists each held PR on the card, never a PR that isn't held, and leaves a release out of Advance", () => {
    next = 640;
    const hold = { reason: "Counter redesign", since: 1 };
    const rows = [row("held", { hold }), row("nudge"), row("held", { hold: { reason: "", since: 2 } })];
    expect(brief(planBatch("release", rows, { selected: false }))).toEqual({ items: ["release quill #640: Release", "release quill #642: Release"], skipped: [] });
    // Advance never lifts a hold: only Release does, and only on your click.
    expect(brief(planBatch("advance", rows, { selected: false })).items).toEqual(["nudge quill #641: Nudge @mira"]);
  });

  it("says why a selected PR won't be released: not held, or its release already waiting; a paused effort's hold releases like any other", () => {
    next = 650;
    const hold = { reason: "Counter redesign", since: 1 };
    const rows = [row("nudge"), row("held", { hold }, { pile: "held" }), row("held", { hold, acted: { kind: "release", state: "queued", at: 1, batchId: "b" } }),
      row("held", { hold, acted: { kind: "release", state: "sent", at: 1, batchId: "b" } }), row("held", { hold }, { pile: "done" })];
    // A release writes nothing to GitHub, so it runs on any pile, as holding a PR does.
    expect(brief(planBatch("release", rows, { selected: true }))).toEqual({ items: ["release quill #651: Release", "release quill #653: Release",
      "release quill #654: Release"], skipped: ["quill #650: It isn't on hold.", "quill #652: Its release is waiting to send."] });
  });
});

describe("sending a deck batch", () => {
  afterEach(() => { vi.useRealTimers(); });
  const store = () => {
    const db = new Database(":memory:");
    db.exec(DECK_BATCH_MIGRATION);
    const sent: string[] = [];
    const hang = { next: false };
    const deps = { db, now: Date.now, changed: () => undefined, piles: async () => () => "active" as const, run: async (item: { prUrl: string }) => {
      sent.push(item.prUrl);
      if (hang.next) { hang.next = false; return await new Promise<never>(() => undefined); }
      return { ok: true as const, detail: "Wrote ready." };
    } };
    const batch = (load: ReturnType<typeof createDeckBatches>, ...rows: PlanRow[]) => load.plan("ready", null, planBatch("ready", rows, { selected: false })).batchId!;
    return { db, sent, hang, deps, batch };
  };
  // A reload loads the replacement, which re-arms each waiting batch, before it disposes the old load, which may still take an Undo.
  it("sends each item once when a replacement load overlaps the old one inside the window, and keeps an Undo the old load took", async () => {
    vi.useFakeTimers();
    next = 640;
    const db = new Database(":memory:");
    db.exec(DECK_BATCH_MIGRATION);
    const sent: string[] = [];
    const deps = { db, now: Date.now, changed: () => undefined, piles: async () => () => "active" as const,
      run: async (item: { prUrl: string }) => { sent.push(item.prUrl); return { ok: true as const, detail: "Wrote ready." }; } };
    const old = createDeckBatches(deps), replacement = createDeckBatches(deps);
    const [undone, kept] = [row("ready"), row("ready")].map((item) => old.plan("ready", null, planBatch("ready", [item], { selected: false })).batchId!);
    for (const id of [undone, kept]) expect(await old.start(id!)).toMatchObject({ ok: true });
    replacement.resume();
    expect(old.undo(undone!)).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sent).toEqual(["https://github.com/inkwell/quill/pull/641"]);
    expect([replacement.get(undone!)?.state, replacement.get(kept!)?.state]).toEqual(["cancelled", "done"]);
    db.close();
  });

  it("finishes what a reload's old load started or was sending after this load resumed, once that load is gone, and never sends twice", async () => {
    vi.useFakeTimers();
    next = 650;
    const { db, sent, hang, deps, batch } = store();
    const old = createDeckBatches(deps), replacement = createDeckBatches(deps);
    const cut = batch(old, row("ready"), row("ready"));
    expect(await old.start(cut)).toMatchObject({ ok: true });
    replacement.resume();
    // The old load wins the send, and GitHub never answers its first write.
    hang.next = true;
    await vi.advanceTimersByTimeAsync(8_000);
    // Still loaded, it takes a start the replacement never saw, then goes before that batch's window ends.
    const late = batch(old, row("ready"));
    expect(await old.start(late)).toMatchObject({ ok: true });
    old.dispose();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(sent).toEqual([650, 651, 652].map((number) => `https://github.com/inkwell/quill/pull/${number}`));
    expect([replacement.get(cut), replacement.get(late)].map((item) => [item?.state, item?.items.map((entry) => entry.state)]))
      .toEqual([["done", ["unknown", "sent"]], ["done", ["sent"]]]);
    replacement.dispose();
    db.close();
  });

  // An older build planned confirmations into Advance; one of those batches still waiting when this build loads must record nothing.
  it("refuses a confirmation left in a batch an older build planned, and sends the rest of that batch", async () => {
    vi.useFakeTimers();
    next = 670;
    const { db, sent, deps } = store();
    const ready = planBatch("ready", [row("ready")], { selected: false }).items[0]!;
    const confirm = { ...ready, prUrl: "https://github.com/inkwell/quill/pull/699", ref: "quill #699", kind: "confirm", what: "Confirm 1 comment handled",
      headOid: HEAD, fingerprint: "f".repeat(64), notes: 1 };
    db.prepare("INSERT INTO deck_batches (id, created_at, state, dispatch_at, body) VALUES (?, ?, 'scheduled', ?, ?)").run("legacy", Date.now(), Date.now() + 1_000,
      JSON.stringify({ kind: "advance", effortId: null, skipped: [], items: [confirm, ready].map((item) => ({ ...item, state: "pending", detail: null, at: null })) }));
    const load = createDeckBatches(deps);
    load.resume();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual([ready.prUrl]);
    expect(load.get("legacy")?.items.map((item) => [item.kind, item.state, item.detail])).toEqual([
      ["confirm", "refused", "Review notes are confirmed one PR at a time now, after reading them. Nothing was recorded."], ["ready", "sent", "Wrote ready."]]);
    load.dispose();
    db.close();
  });

  it("sends nothing of a batch the plugin was closed through past its window, and refuses each PR so its row asks you again", async () => {
    vi.useFakeTimers();
    next = 660;
    const { db, sent, deps, batch } = store();
    const closed = createDeckBatches(deps);
    const id = batch(closed, row("ready"));
    expect(await closed.start(id)).toMatchObject({ ok: true });
    closed.dispose();
    await vi.advanceTimersByTimeAsync(3 * 86_400_000);
    const reopened = createDeckBatches(deps);
    reopened.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);
    expect(reopened.get(id)).toMatchObject({ state: "done", items: [{ state: "refused", detail: expect.stringContaining("The plugin wasn't running when this was due") }] });
    reopened.dispose();
    db.close();
  });
});
