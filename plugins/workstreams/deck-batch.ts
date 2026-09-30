// Batch actions from the effort deck (plan amendment A15). A section button, a
// selection, or Advance first plans: each PR's one write, bound to the facts
// its row showed, and why any PR is left out. You confirm that plan; it sends
// 8 seconds later unless you Undo. Dispatch runs exactly the planned items,
// each through the inventory action's own guards (a fresh read, a hold, a v2
// claim or another writer, and facts changed since the row), so a refusal
// refuses that PR only. Advance plans every safe batch in an effort: confirm
// comments, nudges, review requests, and mark ready, never a merge or a
// thread's work. A PR whose effort you hold or complete after confirming, or
// that leaves its effort, is refused instead of sent. Release (A17.3) lifts
// your holds the same way: listed, then after the window, and never by Advance.
// It writes nothing to GitHub, so it runs on any pile, as holding a PR does.
//
// A batch lives in one row. Undo and dispatch each claim it from `scheduled`
// in one statement, so exactly one wins, even while a reload's replacement
// load overlaps the old one. An item is marked `sending` before
// its write and settled after, so a restart re-arms a waiting batch, keeps a
// cancel, and never sends an item twice: one cut off mid-send is `unknown`.
// A batch the plugin was closed through for over a minute past its window
// sends nothing more: you confirmed it for then, not for whenever it runs again.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ACTED_MS, BATCH_KINDS, DECK_WRITES, needsYou, SEND_DELAY_MS, type BatchKind, type DeckPile, type DeckWrite, type RowActed } from "./deck-shared.js";
import { deckSeenSchema, type DeckRow } from "./deck.js";
import type { ActionResult, ShownReviewers } from "./inventory-actions.js";

/** Append-only: server.ts adds this after PR merge sightings (id 63). */
export const DECK_BATCH_MIGRATION =
  `CREATE TABLE IF NOT EXISTS deck_batches (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, state TEXT NOT NULL, dispatch_at INTEGER, body TEXT NOT NULL)`;
/** A plan you haven't confirmed in this long is out of date. */
const PLAN_TTL_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
/** A batch that shows no sign of life for this long past its window isn't sent: each PR it hadn't reached is refused. */
const LATE_MS = 60_000;

const itemSchema = z.object({
  prUrl: z.string(), ref: z.string(), title: z.string(), kind: z.enum(DECK_WRITES),
  /** The write in a few words: "Nudge @mira", "Request @kai", "Mark ready", "Confirm 2 comments handled", "Release". */
  what: z.string(),
  /** Whom a nudge or request asks. */
  reviewers: z.array(z.string()),
  /** The head Mark ready and a confirmation bind to, and the approval comments a confirmation covers. */
  headOid: z.string().nullable(), fingerprint: z.string().nullable(), notes: z.number(),
  /** The reviewers the row showed, which a request checks before it asks. */
  shown: z.object({ requested: z.array(z.string()), reviewed: z.array(z.object({ login: z.string(), state: z.string() }).strict()) }).strict().nullable(),
  state: z.enum(["pending", "sending", "sent", "refused", "unknown"]),
  /** What GitHub or the guard said, once settled. */
  detail: z.string().nullable(), at: z.number().nullable(),
}).strict();
export type BatchItem = z.infer<typeof itemSchema>;
const skippedSchema = z.object({ prUrl: z.string(), ref: z.string(), reason: z.string() }).strict();
export type Skipped = z.infer<typeof skippedSchema>;
const bodySchema = z.object({ kind: z.enum([...DECK_WRITES, "advance"]), effortId: z.string().nullable(), items: z.array(itemSchema),
  skipped: z.array(skippedSchema) }).strict();
export const deckBatchSchema = bodySchema.extend({
  id: z.string(), createdAt: z.number(),
  state: z.enum(["planned", "scheduled", "dispatching", "done", "cancelled"]),
  /** When a scheduled batch sends. */
  dispatchAt: z.number().nullable(),
}).strict();
export type DeckBatch = z.infer<typeof deckBatchSchema>;

const failure = z.object({ ok: z.literal(false), error: z.string() }).strict();
const batchId = z.object({ batchId: z.string().uuid() }).strict();
export const deckBatchContract = {
  /**
   * What a batch would do, per PR, and nothing yet: the needs-you rows of `kind` in the effort, or of every safe kind for `advance`, or
   * its held PRs for `release`, or just `prUrls` (in the effort, when both are given), where a PR that can't take the write is skipped
   * with why. A request asks `reviewers`, else each PR's first suggested reviewer. `seen` is as deck_get takes it. A plan with items has
   * a `batchId` to start.
   */
  deck_batch_plan: { input: z.object({ kind: z.enum([...DECK_WRITES, "advance"]), effortId: z.string().min(1).max(500).optional(),
    prUrls: z.array(z.string().max(500)).min(1).max(100).optional(), reviewers: z.array(z.string().max(140)).min(1).max(20).optional(),
    seen: deckSeenSchema.optional() }).strict(),
  output: z.discriminatedUnion("ok", [failure, z.object({ ok: z.literal(true), batchId: z.string().nullable(), items: z.array(itemSchema),
    skipped: z.array(skippedSchema) }).strict()]) },
  /**
   * Confirm a plan: it sends after SEND_DELAY_MS unless Undo cancels it first. Refused while any PR in it is off the active pile, except
   * for a release.
   */
  deck_batch_start: { input: batchId, output: z.discriminatedUnion("ok", [failure, z.object({ ok: z.literal(true), dispatchAt: z.number() }).strict()]) },
  /** Cancel a started batch before it sends; once it is sending, nothing more is undone. */
  deck_batch_undo: { input: batchId, output: z.discriminatedUnion("ok", [failure, z.object({ ok: z.literal(true) }).strict()]) },
  /** A batch with each PR's result. */
  deck_batch_get: { input: batchId, output: deckBatchSchema.nullable() },
};

/** A deck row with its pile, when you last marked it seen, and the facts its write binds to, as the row showed them. */
export type PlanRow = { row: Pick<DeckRow, "prUrl" | "repo" | "number" | "title" | "section" | "suggested" | "nudge" | "notes" | "acted" | "hold">;
  pile: DeckPile; seenAt?: number; head: string | null; fingerprint: string | null; shown: ShownReviewers };

const PILE_WHY: Partial<Record<DeckPile, string>> = { held: "Its effort is on hold.", done: "Its effort is done." };
const SECTION_WHY: Record<string, string> = { merge: "Merges go through the merge preview.", work: "Its thread does this work.", flight: "Nothing to do yet.",
  blocked: "It waits on something else.", confirm: "Its next move is confirming comments.", nudge: "Its next move is a nudge.",
  request: "Its next move is a review request.", ready: "Its next move is Mark ready." };
const mentions = (logins: readonly string[]) => logins.map((login) => `@${login}`).join(", ");

/**
 * Each PR's write, in Advance's order, and why any PR it can't take is left out. Without a selection, rows that don't need a write of
 * these kinds are simply not in the plan.
 */
export function planBatch(kind: DeckWrite | "advance", rows: readonly PlanRow[], options: { selected: boolean; reviewers?: readonly string[] }):
  { items: Omit<BatchItem, "state" | "detail" | "at">[]; skipped: Skipped[] } {
  if (kind === "release") return planRelease(rows, options.selected);
  const kinds: readonly BatchKind[] = kind === "advance" ? BATCH_KINDS : [kind];
  const items: Omit<BatchItem, "state" | "detail" | "at">[] = [], skipped: Skipped[] = [];
  for (const { row, pile, seenAt, head, fingerprint, shown } of rows) {
    const ref = `${row.repo.split("/").at(-1)} #${row.number}`;
    const skip = (reason: string) => { if (options.selected) skipped.push({ prUrl: row.prUrl, ref, reason }); };
    const section = kinds.find((candidate) => candidate === row.section);
    if (!options.selected && !section) continue;
    if (row.hold) { skip("On hold. Release it first."); continue; }
    if (!needsYou(row, pile, seenAt)) { skip(PILE_WHY[pile] ?? (row.acted ? "A write on it is waiting or just ran." : SECTION_WHY[row.section]!)); continue; }
    if (!section) { skip(SECTION_WHY[row.section]!); continue; }
    const item = { prUrl: row.prUrl, ref, title: row.title, kind: section, reviewers: [] as string[], headOid: null as string | null, fingerprint: null as string | null,
      notes: 0, shown: null as BatchItem["shown"] };
    if (section === "ready" || section === "confirm") {
      if (!head || (section === "confirm" && !fingerprint)) { skipped.push({ prUrl: row.prUrl, ref, reason: "Not read in full yet. Refresh it first." }); continue; }
      items.push(section === "ready" ? { ...item, what: "Mark ready", headOid: head }
        : { ...item, what: `Confirm ${row.notes} comment${row.notes === 1 ? "" : "s"} handled`, headOid: head, fingerprint, notes: row.notes });
    } else if (section === "nudge") {
      if (!row.nudge.length) { skipped.push({ prUrl: row.prUrl, ref, reason: "No reviewer needs a nudge now." }); continue; }
      items.push({ ...item, what: `Nudge ${mentions(row.nudge)}`, reviewers: [...row.nudge] });
    } else {
      const reviewers = [...options.reviewers ?? row.suggested.slice(0, 1)];
      if (!reviewers.length) { skipped.push({ prUrl: row.prUrl, ref, reason: "No reviewer to suggest. Pick one." }); continue; }
      items.push({ ...item, what: `Request ${mentions(reviewers)}`, reviewers,
        shown: { requested: [...shown.requested], reviewed: shown.reviewed.map(({ login, state }) => ({ login, state })) } });
    }
  }
  return { items: items.sort((a, b) => kinds.indexOf(a.kind as BatchKind) - kinds.indexOf(b.kind as BatchKind)), skipped };
}

/** Release: each held PR, on any pile, unless a release of it is already waiting or sending. */
function planRelease(rows: readonly PlanRow[], selected: boolean): ReturnType<typeof planBatch> {
  const items: ReturnType<typeof planBatch>["items"] = [], skipped: Skipped[] = [];
  for (const { row } of rows) {
    const ref = `${row.repo.split("/").at(-1)} #${row.number}`;
    const skip = (reason: string) => { if (selected) skipped.push({ prUrl: row.prUrl, ref, reason }); };
    if (!row.hold) { skip("It isn't on hold."); continue; }
    if (row.acted?.kind === "release" && (row.acted.state === "queued" || row.acted.state === "sending")) { skip("Its release is waiting to send."); continue; }
    items.push({ prUrl: row.prUrl, ref, title: row.title, kind: "release", what: "Release", reviewers: [], headOid: null, fingerprint: null, notes: 0, shown: null });
  }
  return { items, skipped };
}

type Db = { prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  transaction<T>(fn: () => T): () => T };
export type DeckBatchDeps = {
  db: Db;
  now(): number;
  /** Run one item through the inventory action's guards, which read the PR again first. */
  run(item: BatchItem): Promise<ActionResult>;
  /** Each PR's pile now, from one read: where its effort is, or active on its service card once no effort owns it. */
  piles(): Promise<(prUrl: string) => DeckPile>;
  changed(): void;
};

export function createDeckBatches(deps: DeckBatchDeps) {
  const { db } = deps;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Batches this load is sending. */
  const sending = new Set<string>();
  let again: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const parse = (row: unknown): DeckBatch | null => {
    if (!row) return null;
    const { id, created_at: createdAt, state, dispatch_at: dispatchAt, body } = row as { id: string; created_at: number; state: string; dispatch_at: number | null; body: string };
    return deckBatchSchema.parse({ id, createdAt, state, dispatchAt, ...JSON.parse(body) });
  };
  const get = (id: string) => parse(db.prepare(`SELECT id, created_at, state, dispatch_at, body FROM deck_batches WHERE id = ?`).get(id));
  const claim = (id: string, from: DeckBatch["state"], to: DeckBatch["state"]) =>
    (db.prepare(`UPDATE deck_batches SET state = ? WHERE id = ? AND state = ?`).run(to, id, from) as { changes?: number }).changes === 1;
  /** Only the dispatcher that claimed the batch writes its items. */
  const settle = (id: string, index: number, patch: Partial<BatchItem>) => db.transaction(() => {
    const batch = get(id)!;
    batch.items[index] = { ...batch.items[index]!, ...patch };
    db.prepare(`UPDATE deck_batches SET body = ? WHERE id = ?`).run(JSON.stringify({ kind: batch.kind, effortId: batch.effortId, items: batch.items,
      skipped: batch.skipped }), id);
  })();

  /** Send each item still pending, in order. A PR whose effort left the active pile since you confirmed is refused, unless it's a release. */
  async function send(id: string): Promise<void> {
    sending.add(id);
    try {
      for (;;) {
        if (disposed) return;
        const index = get(id)!.items.findIndex((item) => item.state === "pending");
        if (index === -1) break;
        settle(id, index, { state: "sending", at: deps.now() });
        deps.changed();
        let result: ActionResult;
        try {
          const item = get(id)!.items[index]!;
          const pile = (await deps.piles())(item.prUrl);
          result = pile === "active" || item.kind === "release" ? await deps.run(item) : { ok: false, error: `${PILE_WHY[pile]} Nothing was written.` };
        } catch (error) { result = { ok: false, error: String(error).slice(0, 500) }; }
        // A reload closed this store mid-send: the next load finds the item sending and marks it unknown.
        if (disposed) return;
        settle(id, index, result.ok ? { state: "sent", detail: result.detail, at: deps.now() } : { state: "refused", detail: result.error, at: deps.now() });
        deps.changed();
      }
      claim(id, "dispatching", "done");
      deps.changed();
    } finally { sending.delete(id); }
  }
  async function dispatch(id: string): Promise<void> {
    timers.delete(id);
    if (disposed || !claim(id, "scheduled", "dispatching")) return;
    deps.changed();
    await send(id);
  }
  const arm = (id: string, dispatchAt: number) =>
    timers.set(id, setTimeout(() => void dispatch(id).catch(() => undefined), Math.max(0, dispatchAt - deps.now())));

  return {
    get,
    /** Keep a plan with items for starting, and forget stale plans and old batches. */
    plan(kind: DeckBatch["kind"], effortId: string | null, planned: ReturnType<typeof planBatch>): { batchId: string | null; items: BatchItem[] } {
      const now = deps.now();
      db.prepare(`DELETE FROM deck_batches WHERE (state = 'planned' AND created_at < ?) OR (state IN ('done', 'cancelled') AND created_at < ?)`)
        .run(now - PLAN_TTL_MS, now - 7 * DAY_MS);
      const items = planned.items.map((item): BatchItem => ({ ...item, state: "pending", detail: null, at: null }));
      if (!items.length) return { batchId: null, items };
      const id = randomUUID();
      db.prepare(`INSERT INTO deck_batches (id, created_at, state, dispatch_at, body) VALUES (?, ?, 'planned', NULL, ?)`)
        .run(id, now, JSON.stringify({ kind, effortId, items, skipped: planned.skipped }));
      return { batchId: id, items };
    },
    async start(id: string): Promise<{ ok: true; dispatchAt: number } | { ok: false; error: string }> {
      const batch = get(id);
      if (!batch) return { ok: false, error: "That plan is gone. Review the batch again." };
      if (batch.state !== "planned") return { ok: false, error: "This batch already started." };
      if (batch.createdAt < deps.now() - PLAN_TTL_MS) return { ok: false, error: "This plan is out of date. Review the batch again." };
      const pileOf = await deps.piles();
      const paused = batch.items.find((item) => item.kind !== "release" && pileOf(item.prUrl) !== "active");
      if (paused) return { ok: false, error: `${paused.ref}: ${PILE_WHY[pileOf(paused.prUrl)]} Review the batch again.` };
      const dispatchAt = deps.now() + SEND_DELAY_MS;
      if ((db.prepare(`UPDATE deck_batches SET state = 'scheduled', dispatch_at = ? WHERE id = ? AND state = 'planned'`).run(dispatchAt, id) as { changes?: number })
        .changes !== 1) return { ok: false, error: "This batch already started." };
      arm(id, dispatchAt);
      deps.changed();
      return { ok: true, dispatchAt };
    },
    undo(id: string): { ok: true } | { ok: false; error: string } {
      if (!claim(id, "scheduled", "cancelled")) {
        const state = get(id)?.state;
        return { ok: false, error: state === "cancelled" ? "This batch is already undone." : state === "planned" ? "This batch hasn't started."
          : state === "dispatching" ? "It's already sending. Nothing was undone." : state ? "It already sent. Nothing was undone." : "That batch is gone." };
      }
      clearTimeout(timers.get(id));
      timers.delete(id);
      deps.changed();
      return { ok: true };
    },
    /**
     * After a load, and again once a reload's old load, which may have started or been sending a batch, is gone: a waiting batch waits out
     * the rest of its window, and a batch cut off mid-send finishes without resending anything, unless it is LATE_MS past its last step.
     */
    resume(): void {
      const pickUp = () => {
        for (const { id } of db.prepare(`SELECT id FROM deck_batches WHERE state IN ('scheduled', 'dispatching')`).all() as { id: string }[]) {
          if (disposed || timers.has(id) || sending.has(id)) continue;
          const batch = get(id)!;
          const late = deps.now() - Math.max(batch.dispatchAt!, ...batch.items.map((item) => item.at ?? 0)) > LATE_MS;
          if (batch.state === "scheduled" && !late) { arm(id, batch.dispatchAt!); continue; }
          if (batch.state === "scheduled" && !claim(id, "scheduled", "dispatching")) continue;
          batch.items.forEach((item, index) => {
            if (item.state === "sending") settle(id, index, { state: "unknown", at: deps.now(),
              detail: "The plugin restarted while this was sending, so it wasn't sent again. Refresh the PR to see whether it landed." });
            else if (item.state === "pending" && late) settle(id, index, { state: "refused", at: deps.now(),
              detail: "The plugin wasn't running when this was due, so it wasn't sent. Review it and try again." });
          });
          void send(id).catch(() => undefined);
        }
      };
      pickUp();
      again = setTimeout(pickUp, 2 * SEND_DELAY_MS);
    },
    /**
     * The newest deck write on each PR in the last day: waiting, sending, or settled. An undone batch leaves no mark. Once a batch starts
     * sending, Undo can't stop it, so a PR still waiting its turn reads as sending, not queued.
     */
    acted(): Map<string, RowActed> {
      const out = new Map<string, RowActed>();
      const rows = db.prepare(`SELECT id, created_at, state, dispatch_at, body FROM deck_batches WHERE state IN ('scheduled', 'dispatching', 'done') AND created_at >= ?`)
        .all(deps.now() - ACTED_MS);
      for (const batch of rows.map(parse)) for (const item of batch!.items) {
        const acted: RowActed = { kind: item.kind, state: item.state !== "pending" ? item.state : batch!.state === "scheduled" ? "queued" : "sending",
          at: item.at ?? batch!.dispatchAt! - SEND_DELAY_MS,
          batchId: batch!.id };
        if ((out.get(item.prUrl)?.at ?? -1) <= acted.at) out.set(item.prUrl, acted);
      }
      return out;
    },
    dispose(): void {
      disposed = true;
      clearTimeout(again);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
