import { describe, expect, it } from "vitest";
import { counted, needsYou } from "./deck-shared.js";
import { deckView, type DeckEffortInput, type DeckInput, type DeckRowInput } from "./deck.js";
import { inkwellInventory, inkwellInventoryPrs, INVENTORY_EFFORTS, INVENTORY_NOW } from "./inkwell-fixtures.js";
import type { LinearDetail } from "./linear.js";
import type { Criterion } from "./outcome-evidence.js";

const DAY = 86_400_000;
const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
const effort = (key: keyof typeof INVENTORY_EFFORTS, patch: Partial<DeckEffortInput> = {}): DeckEffortInput => ({ ...INVENTORY_EFFORTS[key], key, goal: "",
  oneOff: false, archived: false, pile: { effortId: INVENTORY_EFFORTS[key].id, pile: "active", reason: "", since: 1 }, parentThreadId: null, tickets: [], criteria: null,
  ...patch });
const ONE_OFFS = { id: "effort-one-offs", name: "One-offs" };
/**
 * The inventory case's 17 PRs as the server hands them to the deck: Shelf order holds folio #340-#343 (an approved stack) and #330
 * (approved but conflicting); Store pickup holds quill #210 and #211 and spine #155 (changes requested) and the approved #212 and #156
 * stacked on them; seven PRs have no effort.
 */
function input(patch: Partial<DeckInput> = {}, row: (row: DeckRowInput) => Partial<DeckRowInput> = () => ({})): DeckInput {
  const prs = new Map(inkwellInventoryPrs().map((pr) => [pr.url, pr]));
  const rows = inkwellInventory().groups.flatMap((group) => group.rows.map((entry): DeckRowInput => {
    const base: DeckRowInput = { ...entry, effort: group.effort, pr: prs.get(entry.prUrl) ?? null, tickets: entry.title.match(/ABC-\d+/gu) ?? [], decision: null,
      acted: null };
    return { ...base, ...row(base) };
  }));
  return { now: INVENTORY_NOW, efforts: [effort("shelf"), effort("pickup")], rows, merges: [], linear: new Map(), threads: new Map(),
    unclassified: { groups: [], oneOffsId: null }, read: { checkedAt: null, refreshing: false }, seen: new Map(), ...patch };
}
const sections = (card: ReturnType<typeof deckView>["active"][number]) =>
  Object.fromEntries(card.sections.map((section) => [section.key, section.rows.map((row) => `${row.repo.split("/")[1]} #${row.number}`)]));
const cardOf = (view: ReturnType<typeof deckView>, id: string) => [...view.active, ...view.held].find((card) => card.id === id)!;

describe("the effort deck", () => {
  it("files each row under the move its inventory row leads with, so the deck and the inventory never disagree about what you do next", () => {
    const view = deckView(input());
    // An approved stack merges in order, so every PR in it is a merge; a stacked PR whose parent needs work waits on that parent.
    expect(sections(cardOf(view, INVENTORY_EFFORTS.shelf.id))).toEqual({ merge: ["folio #340", "folio #341", "folio #342", "folio #343"], work: ["folio #330"] });
    expect(sections(cardOf(view, INVENTORY_EFFORTS.pickup.id))).toEqual({ work: ["quill #210", "quill #211", "spine #155"], blocked: ["quill #212", "spine #156"] });
    expect(cardOf(view, INVENTORY_EFFORTS.pickup.id).blocked.map(({ ref, kind, on }) => [ref, kind, on]))
      .toEqual([["quill #212", "parent", "quill #210"], ["spine #156", "parent", "spine #155"]]);
    // A PR missing a reviewer asks for one first, as its inventory row does, even while it conflicts; one asked 2 hours ago is no nudge yet.
    expect(Object.fromEntries(view.unclassified.rows.map((row) => [`${row.repo.split("/")[1]} #${row.number}`, row.section]))).toEqual({
      "atlas #410": "request", "catalog #96": "nudge", "catalog #97": "work", "folio #301": "confirm", "folio #305": "request", "folio #318": "confirm",
      "folio #325": "request" });
  });

  it("orders the active pile by Needs you with One-offs after every effort, and counts Unclassified PRs as to sort, never as Needs you", () => {
    const loose = [url("folio", 301), url("folio", 318), url("catalog", 96), url("catalog", 97), url("atlas", 410), url("folio", 305)];
    const view = deckView(input({ efforts: [effort("pickup"), effort("shelf"), { ...effort("shelf"), ...ONE_OFFS, key: "one-offs", oneOff: true,
      pile: { effortId: ONE_OFFS.id, pile: "active", reason: "", since: 0 } }] }, (row) => loose.includes(row.prUrl) ? { effort: ONE_OFFS } : {}));
    expect(view.active.map((card) => [card.name, card.needsYou])).toEqual([["Shelf order", 5], ["Store pickup", 3], ["One-offs", 6]]);
    // folio #325 still has a move of yours, but a PR no effort owns is to sort first.
    expect(view.counts).toEqual({ needsYou: 14, toSort: 1, held: 0, done: 0 });
  });

  it("stops counting a row you acted on while its write waits, and once it lands until you mark the view seen; a refusal stays yours", () => {
    const row = { section: "nudge" as const };
    expect(needsYou({ ...row, acted: null }, "active")).toBe(true);
    expect(needsYou({ ...row, acted: { kind: "nudge", state: "queued", at: 5, batchId: null } }, "active")).toBe(false);
    expect(needsYou({ ...row, acted: { kind: "nudge", state: "sending", at: 5, batchId: null } }, "active")).toBe(false);
    expect([4, 5].map((seenAt) => counted({ acted: { kind: "nudge", state: "sent", at: 5, batchId: null } }, seenAt))).toEqual([false, true]);
    expect(needsYou({ ...row, acted: { kind: "nudge", state: "refused", at: 5, batchId: null } }, "active", 0)).toBe(true);
    expect(["held", "done", "unclassified"].map((pile) => needsYou({ ...row, acted: null }, pile as never))).toEqual([false, false, false]);
    expect(needsYou({ section: "blocked", acted: null }, "active")).toBe(false);
    const view = deckView(input({}, (entry) => entry.number === 340 ? { acted: { kind: "ready", state: "queued", at: INVENTORY_NOW, batchId: null } } : {}));
    expect(cardOf(view, INVENTORY_EFFORTS.shelf.id)).toMatchObject({ needsYou: 4, sections: [{ key: "merge", needsYou: 3 }, { key: "work", needsYou: 1 }] });
    // A write that landed stays out of the count until the view says it marked the row seen after it, so a caller that says nothing never
    // counts, or plans, the same move twice.
    expect(needsYou({ ...row, acted: { kind: "nudge", state: "sent", at: 5, batchId: null } }, "active")).toBe(false);
    const landed = (entry: DeckRowInput) => entry.number === 340 ? { acted: { kind: "ready" as const, state: "sent" as const, at: INVENTORY_NOW - 60_000, batchId: null } } : {};
    expect(cardOf(deckView(input({}, landed)), INVENTORY_EFFORTS.shelf.id).needsYou).toBe(4);
    expect(cardOf(deckView(input({ seen: new Map([[url("folio", 340), INVENTORY_NOW]]) }, landed)), INVENTORY_EFFORTS.shelf.id).needsYou).toBe(5);
    // A day on, the write is history: the row counts again, seen or not.
    const old = (entry: DeckRowInput) => entry.number === 340 ? { acted: { kind: "ready" as const, state: "sent" as const, at: INVENTORY_NOW - DAY, batchId: null } } : {};
    expect(cardOf(deckView(input({}, old)), INVENTORY_EFFORTS.shelf.id).needsYou).toBe(5);
  });

  it("pauses a held effort, and files a held PR or one a decision holds under what it waits on", () => {
    const view = deckView(input({ efforts: [effort("shelf", { pile: { effortId: INVENTORY_EFFORTS.shelf.id, pile: "held", reason: "Design review", since: 9 } }),
      effort("pickup")] }, (row) => row.number === 210 ? { hold: { reason: "Waiting on the counter redesign", heldAt: INVENTORY_NOW - DAY } }
      : row.number === 211 ? { decision: { n: 2, question: "Print slips per hold or per visit?", since: INVENTORY_NOW - 2 * DAY } } : {}));
    expect(view.active.map((card) => card.name)).toEqual(["Store pickup"]);
    expect(view.held).toMatchObject([{ name: "Shelf order", needsYou: 0, status: { tone: "held", text: "On hold: Design review" } }]);
    expect(view.counts).toMatchObject({ needsYou: 1, held: 1 });
    // Oldest wait first: the stacked PRs since their push 3 days ago, then the decision, then the hold.
    expect(cardOf(view, INVENTORY_EFFORTS.pickup.id).blocked.map(({ ref, kind, on, what, since }) => [ref, kind, on, what, since])).toEqual([
      ["quill #212", "parent", "quill #210", "Merges after quill #210", INVENTORY_NOW - 3 * DAY],
      ["spine #156", "parent", "spine #155", "Merges after spine #155", INVENTORY_NOW - 3 * DAY],
      ["quill #211", "decision", "D2", "Print slips per hold or per visit?", INVENTORY_NOW - 2 * DAY],
      ["quill #210", "hold", "you", "On hold: Waiting on the counter redesign", INVENTORY_NOW - DAY]]);
  });

  it("keeps a review not yet due a nudge, running checks, and code work a thread is doing in flight: nothing is yours yet, and nothing is blocked", () => {
    const view = deckView(input({}, (row) => row.number === 96 ? { reviewers: { ...row.reviewers, requested: ["mira-l"] }, attention: [],
      pr: { ...row.pr!, reviewRequestedAt: [{ reviewer: "mira-l", at: new Date(INVENTORY_NOW - 5 * 3_600_000).toISOString() }] } }
      : row.number === 318 ? { attention: [], status: "Checks pending" }
      : row.number === 330 ? { threads: { ...row.threads, executor: { id: "thr_folio_330", title: "Fix the shelf conflict", active: true } } } : {}));
    expect(Object.fromEntries(view.unclassified.rows.filter((row) => [96, 318].includes(row.number)).map((row) => [row.number, [row.section, row.waitsOn]])))
      .toEqual({ 96: ["flight", null], 318: ["flight", null] });
    // Its thread is working the conflict now; with that thread idle, the conflict is yours to hand it.
    expect(cardOf(view, INVENTORY_EFFORTS.shelf.id)).toMatchObject({ needsYou: 4, status: { text: "4 need you · 1 in flight" } });
    expect(sections(cardOf(view, INVENTORY_EFFORTS.shelf.id))).toMatchObject({ flight: ["folio #330"] });
  });

  it("sums a card from its rows: stats, merges against open PRs, next steps, who waits on whom, threads, and the week's activity", () => {
    const pickup = INVENTORY_EFFORTS.pickup.id;
    const view = deckView(input({
      efforts: [effort("shelf"), effort("pickup", { parentThreadId: "thr_pickup" })],
      merges: [{ url: url("quill", 200), at: INVENTORY_NOW - DAY, effortId: pickup }, { url: url("quill", 190), at: INVENTORY_NOW - 20 * DAY, effortId: pickup },
        { url: url("folio", 290), at: INVENTORY_NOW - DAY, effortId: INVENTORY_EFFORTS.shelf.id }],
      threads: new Map([["thr_pickup", { title: "Store pickup", status: "idle", updatedAt: INVENTORY_NOW - 9 * DAY }],
        ["thr_quill_211", { title: "Work on quill #211", status: "active", updatedAt: INVENTORY_NOW - 60_000 }]]),
    }));
    const card = cardOf(view, pickup);
    expect(card.status).toEqual({ tone: "you", text: "3 need you · 2 blocked" });
    // Every PR here opened 6 days ago; the stacked PRs have waited since their push 3 days ago, longer than any of your moves is dated.
    expect(card.stats).toEqual({ open: 5, ready: 0, mergedWeek: 1, medianAgeMs: 6 * DAY,
      oldestWait: { prUrl: url("quill", 212), ref: "quill #212", text: "Merges after quill #210", since: INVENTORY_NOW - 3 * DAY } });
    expect(card.progress).toEqual({ merged: 2, open: 5, criteria: null });
    // Without an instruction: your moves first, oldest first, then what waits on others.
    expect(card.next).toEqual([{ text: "Resolve the conflicts", owner: "you", prUrl: url("quill", 210) },
      { text: "Address the requested changes", owner: "you", prUrl: url("quill", 211) }, { text: "Address the requested changes", owner: "you", prUrl: url("spine", 155) }]);
    expect(card.people).toEqual({ youWaitOn: [], waitOnYou: [
      { login: "otto-v", prs: [{ prUrl: url("quill", 210), ref: "quill #210", since: INVENTORY_NOW - DAY }, { prUrl: url("quill", 211), ref: "quill #211", since: INVENTORY_NOW - DAY }] },
      { login: "ines-v", prs: [{ prUrl: url("spine", 155), ref: "spine #155", since: INVENTORY_NOW - DAY }] }] });
    expect(card.threads.map(({ id, role, status }) => [id, role, status])).toEqual([["thr_pickup", "parent", "idle"], ["thr_quill_211", "pr", "active"],
      ["thr_quill_210", "pr", "idle"], ["thr_quill_210_plan", "pr", "idle"], ["thr_spine_155", "pr", "idle"]]);
    // The merge 20 days ago counts toward progress but not this week.
    expect(card.activity.filter((item) => item.kind === "merged")).toEqual([{ kind: "merged", prUrl: url("quill", 200), ref: "quill #200", who: null, at: INVENTORY_NOW - DAY }]);
    expect(card.activity.map((item) => item.kind)).toEqual(["merged", "changes", "changes", "changes", "approved", "approved", "pushed", "pushed", "pushed",
      "pushed", "pushed"]);
  });

  it("names the next steps from the active instruction's unmet criteria, with the PR that carries each, and counts those that hold", () => {
    const criterion = (id: string, status: Criterion["status"], target: string | null, source: Criterion["source"] = "user"): Criterion => ({ id, source,
      label: `Criterion ${id}`, status, affected: target ? [{ target, n: 1 }] : [], next: status === "satisfied" ? null : { action: "validate", owner: "worker",
        wake: "next pass" } });
    // The roster checks gates and tickets too, but those are the rows' own facts: "done when" is what you wrote.
    const view = deckView(input({ efforts: [effort("shelf", { criteria: [criterion("checks", "missing", url("folio", 330), "gate"),
      criterion("ticket:ABC-300", "satisfied", null, "ticket"), criterion("c1", "satisfied", null), criterion("c2", "missing", url("folio", 340)),
      criterion("c3", "blocked", url("folio", 330)), criterion("c4", "missing", null), criterion("c5", "missing", null)] })] }));
    expect(cardOf(view, INVENTORY_EFFORTS.shelf.id)).toMatchObject({ progress: { criteria: { validated: 1, needed: 5 } }, next: [
      { text: "Criterion c2", owner: "worker", prUrl: url("folio", 340) }, { text: "Criterion c3", owner: "worker", prUrl: url("folio", 330) },
      { text: "Criterion c4", owner: "worker", prUrl: null }] });
  });

  it("rolls up only the Linear details the board stores, and says so when it stores none", () => {
    const detail = (identifier: string, state: string, patch: Partial<LinearDetail> = {}): LinearDetail => ({ identifier, title: null, description: null,
      state: { name: state, type: state === "Done" ? "completed" : "started" }, project: null, parent: null, labels: [], url: null, updatedAt: null, source: "agent", ...patch });
    const project = { id: "p1", name: "Shelf order" };
    const view = deckView(input({ efforts: [effort("shelf", { tickets: ["ABC-300"] }), effort("pickup")], linear: new Map([
      ["ABC-300", detail("ABC-300", "Done", { project })], ["ABC-360", detail("ABC-360", "In Review", { project, labels: ["shelves"] })],
      ["ABC-361", detail("ABC-361", "In Review", { parent: { identifier: "ABC-300", title: "Shelf order" }, labels: ["shelves"] })]]) }));
    // The effort's own ticket counts beside its PRs' tickets.
    expect(cardOf(view, INVENTORY_EFFORTS.shelf.id).linear).toEqual({ tickets: 6, known: 3, projects: [{ name: "Shelf order", count: 2 }],
      parents: [{ name: "ABC-300 Shelf order", count: 1 }], states: [{ name: "In Review", type: "started", count: 2 }, { name: "Done", type: "completed", count: 1 }],
      labels: [{ name: "shelves", count: 2 }] });
    expect(cardOf(view, INVENTORY_EFFORTS.pickup.id).linear).toEqual({ tickets: 5, known: 0, projects: [], parents: [], states: [], labels: [] });
  });

  it("lists a done effort by name with what it merged and what is still open, without drawing its card", () => {
    const view = deckView(input({ efforts: [effort("shelf", { pile: { effortId: INVENTORY_EFFORTS.shelf.id, pile: "done", reason: "", since: 7 } }), effort("pickup")],
      merges: [{ url: url("folio", 290), at: INVENTORY_NOW - 30 * DAY, effortId: INVENTORY_EFFORTS.shelf.id }] }));
    expect(view.done).toEqual([{ id: INVENTORY_EFFORTS.shelf.id, key: "shelf", name: "Shelf order", archived: false, since: 7, merged: 1, open: 5 }]);
    expect(view.active.map((card) => card.name)).toEqual(["Store pickup"]);
  });

  it("lists an archived effort with the done ones while it still owns open PRs, so none of yours drops off the deck", () => {
    const archived = effort("pickup", { archived: true, pile: { effortId: INVENTORY_EFFORTS.pickup.id, pile: "done", reason: "", since: 9 } });
    const view = deckView(input({ efforts: [effort("shelf"), archived] }));
    expect(view.done).toEqual([{ id: INVENTORY_EFFORTS.pickup.id, key: "pickup", name: "Store pickup", archived: true, since: 9, merged: 0, open: 5 }]);
    // Its PRs pause as a done effort's do: they are neither Needs you nor to sort.
    expect(view.counts).toEqual({ needsYou: 5, toSort: 7, held: 0, done: 1 });
    // Once they close, it leaves the deck.
    expect(deckView(input({ efforts: [archived], rows: [] })).done).toEqual([]);
  });
});
