import { describe, expect, it } from "vitest";
import type { DeckView } from "./deck.js";
import { inkwellDeck, INVENTORY_EFFORTS, INVENTORY_NOW as NOW } from "./inkwell-fixtures.js";
import { availability, cardScreen, cardSnapshot, hintKeys, paletteItems, stripChips, targets, uncScreen, uncSnapshot, type CardScreen, type KeyContext }
  from "./deck-view-model.js";
import { DECK_ACTIONS } from "./deck-keys.js";

const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
const SHELF = INVENTORY_EFFORTS.shelf.id, PICKUP = INVENTORY_EFFORTS.pickup.id, ONE_OFFS = "effort-one-offs";
const none = { rows: {}, at: {} };
const card = (view: DeckView, id: string, seen: Parameters<typeof cardScreen>[1] = none, details?: ReadonlyMap<string, string>) =>
  cardScreen(view.active.find((item) => item.id === id)!, seen, { now: NOW, details });
const lines = (screen: CardScreen) => Object.fromEntries(screen.sections.map((section) => [section.key, section.lines.map((line) =>
  `${line.ref}${line.needs ? "" : " ·"}${line.dim ? " dim" : ""}${line.ghost ? " ghost" : ""}${line.dot && !line.ghost ? " dot" : ""}${line.trail ? ` [${line.trail.text}]` : ""}`)]));
const context = (screen: CardScreen | "unc", patch: Partial<KeyContext> = {}): KeyContext =>
  ({ view: "deck", cur: screen, focused: null, selected: [], seenAvailable: false, undo: false, held: 1, done: 1, ...patch });

describe("the effort deck's strip", () => {
  it("lists the active pile in session order with each card's Needs you, then Unclassified with what's to sort, and numbers the first nine", () => {
    const view = inkwellDeck();
    const cards = new Map(view.active.map((item) => [item.id, card(view, item.id)]));
    const unc = uncScreen(view, none, new Map(), { now: NOW });
    const chips = stripChips(view.active.map((item) => item.id), cards, { toSort: unc.coverage.toSort, changed: unc.changed }, SHELF);
    expect(chips.map((chip) => [chip.n, chip.name, chip.count])).toEqual([[1, "Shelf order", 5], [2, "Store pickup", 3], [3, "One-offs", 3], [4, "Unclassified", 4]]);
    // A card keeps its number after you flip away and a read reorders the server's pile: the session order wins.
    expect(stripChips([PICKUP, ONE_OFFS, SHELF], cards, { toSort: 4, changed: 0 }, SHELF).map((chip) => chip.name))
      .toEqual(["Store pickup", "One-offs", "Shelf order", "Unclassified"]);
  });
});

describe("an effort card", () => {
  it("files rows by the move they need, with one batch button per section and none for code work, which each PR's thread does", () => {
    const shelf = card(inkwellDeck(), SHELF);
    expect(lines(shelf)).toEqual({ merge: ["folio #340", "folio #341", "folio #342", "folio #343"], work: ["folio #330 [Work on folio #330]"] });
    // Each line says only what its section doesn't: who approved a merge, whom a nudge asks, how many notes wait.
    expect(shelf.sections[0]!.lines[0]!.info).toEqual({ text: "✓ @mira-l", tone: null });
    expect(shelf.sections.map((section) => [section.key, section.count, section.action?.label ?? null, section.action?.key ?? null]))
      .toEqual([["merge", 4, "Preview merge", "m"], ["work", 1, null, null]]);
    const pickup = card(inkwellDeck(), PICKUP);
    expect(pickup.sections.find((section) => section.key === "blocked")!.lines.map((line) => [line.ref, line.needs, line.info?.text]))
      .toEqual([["quill #212", false, "Merges after quill #210"], ["spine #156", false, "Merges after spine #155"]]);
  });

  it("keeps a row a read changed where you saw it, dimmed and out of Needs you, until you mark the card seen", () => {
    const before = inkwellDeck();
    const seen = { rows: { [SHELF]: cardSnapshot(before.active.find((item) => item.id === SHELF)!) }, at: {} };
    // folio #342 lost its approval on this read, so #343, stacked on it, no longer merges in order either.
    const after = inkwellDeck({}, (row) => row.number === 342 ? { attention: [], status: "Awaiting review", stage: "review" } : {});
    const shelf = card(after, SHELF, seen);
    expect(lines(shelf).merge).toEqual(["folio #340", "folio #341", "folio #342 · dim dot [→ Awaiting review]", "folio #343 · dim dot [→ Behind #342]"]);
    expect([shelf.needsYou, shelf.sections[0]!.count, shelf.changed]).toEqual([3, 2, 2]);
    // Mark seen takes the card as it is now, and the row settles where it belongs.
    const marked = card(after, SHELF, { rows: { [SHELF]: cardSnapshot(after.active.find((item) => item.id === SHELF)!) }, at: {} });
    expect(lines(marked).merge).not.toContain("folio #342 · dim dot [→ Awaiting review]");
    expect(marked.changed).toBe(0);
  });

  it("keeps a PR that merged elsewhere as a ghost on its line, and a new PR at its section's end, marked", () => {
    const before = inkwellDeck();
    const seen = { rows: { [SHELF]: cardSnapshot(before.active.find((item) => item.id === SHELF)!).filter((row) => row.prUrl !== url("folio", 343)) }, at: {} };
    const after = inkwellDeck({}, (row) => row.number === 341 ? { effort: null } : {});
    expect(lines(card(after, SHELF, seen)).merge).toEqual(["folio #340", "folio #341 · dim ghost [Left]", "folio #342", "folio #343 dot"]);
  });

  it("dims a row you acted on and offers Undo while its batch waits, keeps it dim once sent until Mark seen, and gives a refusal back to you", () => {
    const acted = (state: "queued" | "sent" | "refused", at = NOW) => inkwellDeck({}, (row) => row.number === 96 ? { acted: { kind: "nudge", state, at, batchId: "b1" } } : {});
    const nudge = (screen: CardScreen) => screen.sections.find((section) => section.key === "nudge")!;
    expect(nudge(card(acted("queued"), ONE_OFFS)).lines[0]).toMatchObject({ needs: false, dim: true, trail: { kind: "acted", text: "Nudging…", undo: "b1" } });
    expect(card(acted("queued"), ONE_OFFS).settleable).toBe(false);
    const sent = card(acted("sent"), ONE_OFFS);
    expect(nudge(sent).lines[0]).toMatchObject({ needs: false, dim: true, trail: { text: "Nudged", undo: null } });
    expect(sent.settleable).toBe(true);
    // Marked seen after it landed, it counts again (the server has moved it on by then).
    const marked = card(acted("sent", NOW - 5), ONE_OFFS, { rows: {}, at: { [url("catalog", 96)]: NOW } });
    expect(nudge(marked).lines[0]!.needs).toBe(true);
    // Nothing is left for Mark seen then, so it isn't offered again for the rest of the day the write stays on the row.
    expect(marked.settleable).toBe(false);
    const refused = card(acted("refused"), ONE_OFFS, none, new Map([[url("catalog", 96), "@mira-l already reviewed it."]]));
    expect(nudge(refused).lines[0]).toMatchObject({ needs: true, dim: false, trail: { text: "Not sent", failed: true, title: "@mira-l already reviewed it." } });
    // A refusal never dimmed the row, so Mark seen has nothing to settle.
    expect(refused.settleable).toBe(false);
  });

  it("gives Advance only the safe moves drawn as needing you: never a merge, a thread's work, or a row dimmed until Mark seen", () => {
    expect([card(inkwellDeck(), SHELF).advance, card(inkwellDeck(), ONE_OFFS).advance.length, card(inkwellDeck(), PICKUP).advance]).toEqual([[], 3, []]);
    // catalog #96 was in flight when you last marked One-offs seen. Now due a nudge, it waits dimmed where you saw it, so Advance, which
    // plans exactly these PRs, leaves it out, as its count on the button does.
    const view = inkwellDeck();
    const seen = { rows: { [ONE_OFFS]: cardSnapshot(view.active.find((item) => item.id === ONE_OFFS)!)
      .map((row) => row.prUrl === url("catalog", 96) ? { ...row, section: "flight", status: "In review" } : row) }, at: {} };
    expect(card(view, ONE_OFFS, seen).advance).toEqual([url("folio", 301), url("folio", 318)]);
  });

  it("words each tile from the card: next steps, blocked, stats, threads, stored Linear details, people, and recent activity", () => {
    const shelf = card(inkwellDeck(), SHELF);
    expect(shelf.stats).toMatchObject({ open: 5, mergedWeek: 1, median: "6d", bar: [{ key: "ready", count: 4 }, { key: "fix", count: 1 }] });
    expect(shelf.linear).toEqual({ summary: "Shelf redesign", lines: ["1 of 5 tickets have stored details", "Project Shelf redesign", "States In Review", "Labels #shelves"] });
    expect(shelf.next.items[0]).toMatchObject({ ref: "folio #340" });
    const pickup = card(inkwellDeck(), PICKUP);
    expect(pickup.threads[0]).toMatchObject({ title: "Store pickup", ref: "parent", age: "2h", dot: false });
    expect(pickup.blocked.map((item) => [item.ref, item.on, item.age])).toEqual([["quill #212", "quill #210", "3d"], ["spine #156", "spine #155", "3d"]]);
    expect(pickup.people.summary).toBe("@otto-v waits on you");
    expect(card(inkwellDeck(), PICKUP).linear.summary).toBe("no details stored");
  });
});

describe("the Unclassified deck", () => {
  it("groups PRs by suggestion with the reason once per group, one button each, and each PR's signals", () => {
    const unc = uncScreen(inkwellDeck(), none, new Map(), { now: NOW });
    expect(unc.groups.map((group) => [group.title, group.reason, group.confidence, group.button.label, group.lines.map((line) => [line.ref, line.signals])])).toEqual([
      ["Shelf order", "Shared ticket · same ticket prefix", "high", "Put 1 in Shelf order", [["folio #325", ["ticket ABC-355", "prefix ABC"]]]],
      ["Delivery windows", "Shared ticket ABC-210, no effort yet", "medium", "New effort from 2…",
        [["atlas #410", ["ticket ABC-210"]], ["catalog #97", ["board group “Checkout”"]]]],
      ["No clear signal", "Pick an effort for each PR.", null, "Pick per PR", [["folio #305", []]]]]);
    // Unclassified PRs are to sort, never Needs you.
    expect(unc.groups.flatMap((group) => group.lines).some((line) => line.needs)).toBe(false);
  });

  it("counts coverage as the open PRs in a real effort, with One-offs and what's to sort beside it", () => {
    expect(uncScreen(inkwellDeck(), none, new Map(), { now: NOW }).coverage).toEqual({ efforts: 10, oneOffs: 3, toSort: 4, total: 17, pct: 59 });
  });

  it("collapses a group you accepted to one line with Undo, and keeps the next group where it was", () => {
    const before = inkwellDeck();
    const seen = { rows: { unc: uncSnapshot(before) }, at: {} };
    const after = inkwellDeck({ unclassified: { ...before.unclassified, groups: before.unclassified.groups.slice(1) } },
      (row) => row.number === 325 ? { effort: INVENTORY_EFFORTS.shelf } : {});
    const unc = uncScreen(after, seen, new Map([[before.unclassified.groups[0]!.key, { actionId: "a1", text: "1 PR → Shelf order", prUrls: [url("folio", 325)] }]]),
      { now: NOW });
    expect(unc.groups.map((group) => [group.title, group.accepted?.text ?? null, group.lines.length])).toEqual([["Left since you looked", "1 PR → Shelf order", 0],
      ["Delivery windows", null, 2], ["No clear signal", null, 1]]);
    expect(unc.changed).toBe(0);
  });

  it("keeps a group open while any of it is left to sort, so accepting part of it hides none of the rest", () => {
    const before = inkwellDeck();
    const seen = { rows: { unc: uncSnapshot(before) }, at: {} };
    // You selected atlas #410 and accepted Delivery windows for it alone; catalog #97 is still to sort.
    const after = inkwellDeck({}, (row) => row.number === 410 ? { effort: INVENTORY_EFFORTS.shelf } : {});
    const unc = uncScreen(after, seen, new Map([["new:ABC-210", { actionId: "a1", text: "1 PR → Delivery windows", prUrls: [url("atlas", 410)] }]]), { now: NOW });
    const group = unc.groups.find((item) => item.key === "new:ABC-210")!;
    expect([group.accepted, group.button.label, group.lines.map((line) => [line.ref, line.ghost])]).toEqual([null, "New effort from 1…",
      [["atlas #410", true], ["catalog #97", false]]]);
  });
});

describe("what the keys act on", () => {
  it("takes the selection first, then the focused row when it has the move, then every row in the card with it", () => {
    const oneOffs = card(inkwellDeck(), ONE_OFFS);
    const all = oneOffs.sections.flatMap((section) => section.lines);
    const [confirm301, confirm318, nudge96] = all;
    expect(targets("confirm", { cur: oneOffs, focused: null, selected: [] }).map((line) => line.ref)).toEqual(["folio #301", "folio #318"]);
    expect(targets("confirm", { cur: oneOffs, focused: confirm318!, selected: [] }).map((line) => line.ref)).toEqual(["folio #318"]);
    // A focused row without the move doesn't narrow it: n on a confirm row still nudges the card's one overdue review.
    expect(targets("nudge", { cur: oneOffs, focused: confirm301!, selected: [] }).map((line) => line.ref)).toEqual(["catalog #96"]);
    expect(targets("confirm", { cur: oneOffs, focused: null, selected: [confirm301!, nudge96!] }).map((line) => line.ref)).toEqual(["folio #301"]);
  });

  it("offers each action only where it can run, and says why it can't", () => {
    const shelf = card(inkwellDeck(), SHELF);
    const on = availability(context(shelf));
    expect([on.merge.on, on.advance.on, on.nudge.on, on.nudge.why, on.accept.on, on.hold.on]).toEqual([true, false, false, "no nudge is due", false, true]);
    const oneOffs = availability(context(card(inkwellDeck(), ONE_OFFS)));
    expect([oneOffs.hold.on, oneOffs.hold.why, oneOffs.complete.on]).toEqual([false, "One-offs stays active", false]);
    const unc = uncScreen(inkwellDeck(), none, new Map(), { now: NOW });
    const focused = unc.groups[0]!.lines[0]!;
    const sorting = availability(context("unc", { focused }));
    expect([sorting.accept.on, sorting.move.on, sorting.advance.on, sorting.advance.why]).toEqual([true, true, false, "open an effort card"]);
    // In All PRs, the deck's flips are the deck's; the row's own moves and thread come from its inventory row.
    const prs = availability({ ...context(shelf), view: "prs", cur: null, prs: { row: true, thread: true, moves: new Set(["nudge"]) } });
    expect([prs.next.on, prs.next.why, prs.nudge.on, prs.confirm.on, prs["open-thread"].on, prs.seen.on]).toEqual([false, "Efforts only", true, false, true, false]);
  });

  it("keeps the hint bar to the few keys that apply now", () => {
    const shelf = card(inkwellDeck(), SHELF);
    expect(hintKeys(context(shelf), availability(context(shelf)))).toEqual([["] →", "flip"], ["j ↓", "rows"], ["m", "merge"]]);
    const focused = shelf.sections[0]!.lines[0]!;
    expect(hintKeys(context(shelf, { focused }), availability(context(shelf, { focused })))).toEqual([["j ↓", "rows"], ["m", "preview merge"],
      ["x", "select"], ["↵", "details"]]);
  });

  it("lists every action in the palette with its key, and each effort to go to, resume, or reopen", () => {
    const view = inkwellDeck();
    const cards = new Map(view.active.map((item) => [item.id, card(view, item.id)]));
    const chips = stripChips(view.active.map((item) => item.id), cards, { toSort: 4, changed: 0 }, SHELF);
    const items = paletteItems(availability(context(cards.get(SHELF)!)), chips, { held: [{ id: "effort-gift-cards", name: "Gift cards" }],
      done: [{ id: "effort-store-hours", name: "Store hours", archived: false }, { id: "effort-old", name: "Old", archived: true }] }, SHELF, true);
    expect(items.filter((item) => item.action).map((item) => item.key)).toEqual(DECK_ACTIONS.filter((action) => action.id !== "jump").map((action) => action.id));
    expect(items.filter((item) => item.target).map((item) => [item.title, item.keys.join(""), item.on])).toEqual([["Go to Shelf order", "1", false],
      ["Go to Store pickup", "2", true], ["Go to One-offs", "3", true], ["Go to Unclassified", "4", true], ["Resume Gift cards", "", true], ["Reopen Store hours", "", true],
      ["Reopen Old", "", false]]);
  });
});
