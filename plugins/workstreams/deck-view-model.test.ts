import { describe, expect, it } from "vitest";
import type { DeckView } from "./deck.js";
import { inkwellDeck, inkwellSuggestions, inkwellThreads, INVENTORY_EFFORTS, INVENTORY_NOW as NOW } from "./inkwell-fixtures.js";
import { acceptPlan, availability, cardScreen, cardSnapshot, hintKeys, keptServiceCards, paletteItems, readText, stripChips, targets, type Accepted,
  type CardScreen, type KeyContext } from "./deck-view-model.js";
import { DECK_ACTIONS } from "./deck-keys.js";

const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
const SHELF = INVENTORY_EFFORTS.shelf.id, PICKUP = INVENTORY_EFFORTS.pickup.id, ONE_OFFS = "effort-one-offs";
const FOLIO = "service:inkwell/folio", ATLAS = "service:inkwell/atlas", CATALOG = "service:inkwell/catalog";
const none = { rows: {}, at: {} };
const card = (view: DeckView, id: string, seen: Parameters<typeof cardScreen>[1] = none, details?: ReadonlyMap<string, string>,
  sorted: { accepted?: Accepted; moved?: ReadonlyMap<string, string> } = {}) => cardScreen(view.active.find((item) => item.id === id)!, seen, { now: NOW, details, ...sorted });
const lines = (screen: CardScreen) => Object.fromEntries(screen.sections.map((section) => [section.key, section.lines.map((line) =>
  `${line.ref}${line.needs ? "" : " ·"}${line.dim ? " dim" : ""}${line.ghost ? " ghost" : ""}${line.dot && !line.ghost ? " dot" : ""}${line.trail ? ` [${line.trail.text}]` : ""}`)]));
const context = (screen: CardScreen, patch: Partial<KeyContext> = {}): KeyContext =>
  ({ view: "deck", cur: screen, service: FOLIO, focused: null, selected: [], seenAvailable: false, undo: false, held: 1, done: 1, ...patch });

describe("the effort deck's strip", () => {
  it("lists the active pile in session order with each card's Needs you, the service cards after the efforts, and numbers the first nine", () => {
    const view = inkwellDeck();
    const cards = new Map(view.active.map((item) => [item.id, card(view, item.id)]));
    const chips = stripChips(view.active.map((item) => item.id), cards, SHELF);
    expect(chips.map((chip) => [chip.n, chip.name, chip.count, chip.service])).toEqual([[1, "Shelf order", 5, false], [2, "Store pickup", 3, false],
      [3, "One-offs", 3, false], [4, "folio · service", 2, true], [5, "atlas · service", 1, true], [6, "catalog · service", 1, true]]);
    // A card keeps its number after you flip away and a read reorders the server's pile: the session order wins.
    expect(stripChips([PICKUP, ONE_OFFS, SHELF, CATALOG], cards, SHELF).map((chip) => chip.name))
      .toEqual(["Store pickup", "One-offs", "Shelf order", "catalog · service"]);
  });

  it("ends with a service card for a repository with only threads, and Loose threads, gray, neither counting in Needs you", () => {
    const view = inkwellDeck(inkwellThreads());
    const cards = new Map(view.active.map((item) => [item.id, card(view, item.id)]));
    expect(stripChips(view.active.map((item) => item.id), cards, SHELF).slice(-2).map((chip) => [chip.n, chip.name, chip.count, chip.service, chip.color]))
      .toEqual([[7, "quill · service", 0, true, "#d3a35a"], [8, "Loose threads", 0, true, "#8f8e8a"]]);
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
    // A read that saw it merge says so.
    const merged = inkwellDeck({ merges: [{ url: url("folio", 341), at: NOW - 60_000, effortId: SHELF }] }, (row) => row.number === 341 ? { effort: null } : {});
    expect(lines(card(merged, SHELF, seen)).merge[1]).toBe("folio #341 · dim ghost [Merged]");
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

  it("marks a row whose last read failed, always, and one the last full read didn't list, so a stale row never reads as fresh", () => {
    const view = inkwellDeck({}, (row) => row.number === 340 ? { failure: { at: new Date(NOW - 3_600_000).toISOString(), error: "timeout" } }
      : row.number === 341 ? { stale: true, checkedAt: new Date(NOW - 11 * 60_000).toISOString() } : {});
    const [fail, stale, fresh] = card(view, SHELF).sections[0]!.lines;
    expect([fail!.checked, stale!.checked?.text, fresh!.checked]).toEqual([{ text: "read failed", failed: true,
      title: "GitHub didn't answer its last read; its last good read was 25s ago. Refresh reads it again." }, "stale 11m", null]);
    // GitHub's rate limit shows in the top bar while it holds reads, and not after.
    expect(readText({ ...view, limitedUntil: NOW + 10 * 60_000 }, NOW)).toMatch(/^Rate-limited until .+ · Read 25s ago$/u);
    expect(readText({ ...view, limitedUntil: NOW - 1 }, NOW)).toBe("Read 25s ago");
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
    expect(shelf.linear).toEqual({ summary: "Shelf redesign", chips: [{ kind: "project", text: "Shelf redesign" }, { kind: "label", text: "shelves" }],
      bar: [{ name: "In Review", count: 1, tone: "blue" }], target: null, lines: [["States", "1 in review"], ["Read", "1 of 5 tickets"]] });
    expect(shelf.next.items[0]).toMatchObject({ ref: "folio #340" });
    const pickup = card(inkwellDeck(), PICKUP);
    expect(pickup.threads[0]).toMatchObject({ title: "Store pickup", ref: "parent", age: "2h", dot: false });
    expect(pickup.blocked.map((item) => [item.ref, item.on, item.age])).toEqual([["quill #212", "quill #210", "3d"], ["spine #156", "spine #155", "3d"]]);
    expect(pickup.people.summary).toBe("@otto-v waits on you");
    expect(card(inkwellDeck(), PICKUP).linear).toEqual({ summary: "no Linear data", chips: [], bar: [], target: null, lines: [] });
  });

  it("words the Linear tile from what Linear gave: project and initiative chips, label tags, states, cycle, assignees, and target date", () => {
    const detail = (identifier: string, patch: object) => ({ identifier, title: null, description: null, state: { name: "In Progress", type: "started" },
      project: { id: "p1", name: "Shelf redesign", targetDate: "2026-10-17", initiatives: [{ id: "i1", name: "Reading rooms" }] }, parent: null, labels: ["shelves"],
      cycle: { number: 42, name: null, endsAt: "2026-10-03T00:00:00.000Z" }, url: null, updatedAt: null, source: "key" as const, ...patch });
    const view = inkwellDeck({ linear: new Map([["ABC-360", detail("ABC-360", { assignee: "dana" })], ["ABC-361", detail("ABC-361", { assignee: "kai",
      state: { name: "Done", type: "completed" } })]]) });
    expect(card(view, SHELF).linear).toEqual({ summary: "Shelf redesign · target Oct 17",
      chips: [{ kind: "project", text: "Shelf redesign" }, { kind: "initiative", text: "Reading rooms" }, { kind: "label", text: "shelves" }],
      bar: [{ name: "Done", count: 1, tone: "green" }, { name: "In Progress", count: 1, tone: "blue" }], target: "target Oct 17",
      lines: [["States", "1 done · 1 in progress"], ["Cycle", "Cycle 42 → Oct 3"], ["Assignees", "dana, kai"], ["Target", "Oct 17 Shelf redesign"], ["Read", "2 of 5 tickets"]] });
    // The target named beside the top project is that project's: a smaller project's date would read as the top one's.
    const two = inkwellDeck({ linear: new Map([["ABC-360", detail("ABC-360", { project: { id: "p1", name: "Shelf redesign", targetDate: null, initiatives: [] } })],
      ["ABC-361", detail("ABC-361", { project: { id: "p1", name: "Shelf redesign", targetDate: null, initiatives: [] } })],
      ["ABC-362", detail("ABC-362", { project: { id: "p2", name: "Store hours", targetDate: "2026-12-01", initiatives: [] } })]]) });
    expect(card(two, SHELF).linear).toMatchObject({ summary: "Shelf redesign", target: null, lines: expect.arrayContaining([["Target", "Dec 1 Store hours"]]) });
  });
});

describe("a service card", () => {
  it("files its rows by the move they need, as an effort's are, counts them as Needs you, and names each row's suggestion", () => {
    const folio = card(inkwellDeck(), FOLIO);
    expect(lines(folio)).toEqual({ request: ["folio #305", "folio #325"] });
    expect(folio.needsYou).toBe(2);
    expect(folio.sections.flatMap((section) => section.lines).map((line) => [line.ref, line.signals])).toEqual([["folio #305", []], ["folio #325", ["→ Shelf order"]]]);
    expect(card(inkwellDeck(), ATLAS).sections[0]!.lines[0]!.signals).toEqual(["→ new Delivery windows"]);
    expect(card(inkwellDeck(), SHELF).suggest).toEqual([]);
  });

  it("shows each suggestion over its rows once, with its strength, signals, and one button, and each PR's own signals", () => {
    const folio = card(inkwellDeck(), FOLIO);
    expect(folio.suggest.map((group) => [group.key, group.title, group.strength, group.signals, group.button.label, group.lines.map((line) => [line.ref, line.signals])]))
      .toEqual([[`${FOLIO} effort:${SHELF}:high`, "Shelf order", "strong", ["ticket ABC-355", "prefix ABC"], "Put 1 in Shelf order", [["folio #325", ["ticket ABC-355", "prefix ABC"]]]],
        [`${FOLIO} none`, "No clear signal", null, [], "Pick per PR", [["folio #305", []]]]]);
    expect(folio.suggest.at(-1)!.reason).toBe("Pick an effort for each PR.");
    // A suggestion that spans two repositories shows on each of their cards, over the PRs on that card.
    expect([ATLAS, CATALOG].map((id) => card(inkwellDeck(), id).suggest.map((group) => [group.key, group.button.label, group.lines.map((line) => line.ref)])))
      .toEqual([[[`${ATLAS} new:ABC-210`, "New effort from 1…", ["atlas #410"]]], [[`${CATALOG} new:ABC-210`, "New effort from 1…", ["catalog #97"]]]]);
  });

  // A weak suggestion rests on one faint signal, so the one button that would move its PRs at once asks first. A new effort's naming dialog
  // already asks, and strong or moderate groups move on one click, with Undo.
  it("asks again before a weak group moves anything", () => {
    const [shelf, delivery, rest] = inkwellSuggestions();
    const view = inkwellDeck({ classify: { oneOffsId: ONE_OFFS, groups: [
      { ...shelf!, key: `effort:${SHELF}:low`, confidence: "low", reason: "Same code area", signals: ["area inkwell/folio:shelves"] },
      { ...delivery!, confidence: "low" },
      { ...rest!, key: "one-off", target: { kind: "one-off" }, confidence: "medium", reason: "Standalone ticket that nothing else carries", signals: ["standalone ticket ABC-305"] }] } });
    const folio = card(view, FOLIO);
    expect(folio.suggest.map((group) => [group.title, group.strength, group.button.label, group.button.confirm])).toEqual([
      ["Shelf order", "weak", "Put 1 in Shelf order…", true], ["One-offs", "moderate", "Mark 1 one-off", false]]);
    expect(card(view, ATLAS).suggest.map((group) => [group.title, group.strength, group.button.label, group.button.confirm]))
      .toEqual([["Delivery windows", "weak", "New effort from 1…", false]]);
    expect(card(inkwellDeck(), FOLIO).suggest.map((group) => group.button.confirm)).toEqual([false, false]);
    // Across groups, Accept takes the rest and leaves each weak one for its own confirm, and says so; alone, its Accept opens that confirm.
    const keys = folio.suggest.map((group) => group.key);
    expect(acceptPlan(folio.suggest, keys)).toEqual({ take: [`${FOLIO} one-off`], left: "1 weak group left: accept it alone." });
    expect(acceptPlan(folio.suggest, [keys[0]!])).toEqual({ take: [keys[0]], left: null });
  });

  it("collapses a group you accepted to one line with Undo where it was, and keeps each row it moved where it was, saying where it went", () => {
    const before = inkwellDeck();
    const seen = { rows: { [FOLIO]: cardSnapshot(before.active.find((item) => item.id === FOLIO)!) }, at: {} };
    const [shelf, ...rest] = inkwellSuggestions();
    const after = inkwellDeck({ classify: { oneOffsId: ONE_OFFS, groups: rest } }, (row) => row.number === 325 ? { effort: INVENTORY_EFFORTS.shelf } : {});
    const key = `${FOLIO} ${shelf!.key}`;
    const folio = card(after, FOLIO, seen, undefined, { accepted: new Map([[key, { actionId: "a1", text: "1 PR → Shelf order", prUrls: [url("folio", 325)], index: 0 }]]),
      moved: new Map([[url("folio", 325), "Shelf order"]]) });
    expect(folio.suggest.map((group) => [group.title, group.accepted?.text ?? null, group.lines.length])).toEqual([["Moved", "1 PR → Shelf order", 0],
      ["No clear signal", null, 1]]);
    // It moved at your click, so it's no news: no dot, and nothing counts as changed, but Mark seen is there to settle it.
    expect(lines(folio).request).toEqual(["folio #305", "folio #325 · dim ghost [→ Shelf order]"]);
    expect([folio.changed, folio.settleable, folio.needsYou]).toEqual([0, true, 1]);
  });

  // A17(6) and PLACE-LOSS #2: atlas #410 is the only PR on its service card, so moving it, or its merging on a poll, would take the card
  // and every result on it away under you. The card stays, empty, until you mark it seen.
  it("keeps a service card whose last PR left as a stand-in with its ghost rows and accepted groups until Mark seen", () => {
    const before = inkwellDeck();
    const snapshot = cardSnapshot(before.active.find((item) => item.id === ATLAS)!);
    expect(snapshot.map((row) => row.ref)).toEqual(["atlas #410"]);
    const after = inkwellDeck({}, (row) => row.repo === "inkwell/atlas" && row.number === 410 ? { effort: INVENTORY_EFFORTS.pickup } : {});
    expect(after.active.map((item) => item.id)).not.toContain(ATLAS);
    const order = before.active.map((item) => item.id);
    const accepted: Accepted = new Map([[`${ATLAS} effort:${PICKUP}:high`, { actionId: "a1", text: "1 PR → Store pickup", prUrls: [url("atlas", 410)], index: 0 }]]);
    const [kept] = keptServiceCards(order, after.active, { [ATLAS]: snapshot }, accepted);
    expect([kept!.id, kept!.kind, kept!.name, kept!.needsYou, kept!.stats.open]).toEqual([ATLAS, "service", "atlas · service", 0, 0]);
    const atlas = cardScreen(kept!, { rows: { [ATLAS]: snapshot }, at: {} }, { now: NOW, accepted, moved: new Map([[url("atlas", 410), "Store pickup"]]) });
    expect(Object.values(lines(atlas)).flat()).toEqual(["atlas #410 · dim ghost [→ Store pickup]"]);
    expect([atlas.suggest.map((group) => group.accepted?.text), atlas.settleable, atlas.status.text]).toEqual([["1 PR → Store pickup"], true, "No open PRs"]);
    // Mark seen leaves nothing to settle, so it goes; so does a card this session never showed, and one a read still draws.
    expect(keptServiceCards(order, after.active, { [ATLAS]: [] }, new Map())).toEqual([]);
    expect(keptServiceCards(order.filter((id) => id !== ATLAS), after.active, { [ATLAS]: snapshot }, accepted)).toEqual([]);
    expect(keptServiceCards(order, before.active, { [ATLAS]: snapshot }, accepted)).toEqual([]);
  });

  it("keeps a group open while any of it is left here, so accepting part of it hides none of the rest", () => {
    const [shelf, , rest] = inkwellSuggestions();
    const both = { ...shelf!, prs: [...shelf!.prs, rest!.prs[0]!] };
    const view = inkwellDeck({ classify: { oneOffsId: ONE_OFFS, groups: [both] } });
    // You selected folio #325 and accepted Shelf order for it alone; folio #305 is still here.
    const folio = card(view, FOLIO, none, undefined, { accepted: new Map([[`${FOLIO} ${shelf!.key}`, { actionId: "a1", text: "1 PR → Shelf order",
      prUrls: [url("folio", 325)], index: 0 }]]) });
    expect(folio.suggest.map((group) => [group.accepted, group.button.label, group.lines.map((line) => line.ref)])).toEqual([[null, "Put 2 in Shelf order",
      ["folio #305", "folio #325"]]]);
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
    expect([oneOffs.hold.on, oneOffs.hold.why, oneOffs.complete.on, oneOffs.promote.on, oneOffs.accept.on]).toEqual([false, "One-offs stays active", false, false, false]);
    // A service card acts like an effort's, sorts its rows into efforts, and promotes, but never holds or completes: it isn't an effort yet.
    const folio = card(inkwellDeck(), FOLIO);
    const focused = folio.sections[0]!.lines[0]!;
    const sorting = availability(context(folio, { focused }));
    expect([sorting.accept.on, sorting.move.on, sorting["one-off"].on, sorting.request.on, sorting.advance.on, sorting.promote.on, sorting.hold.on, sorting.hold.why,
      sorting["new-effort"].on]).toEqual([true, true, true, true, true, true, false, "this card stays active", false]);
    expect(availability(context(folio, { focused, selected: [focused] }))["new-effort"].on).toBe(true);
    // Loose threads holds only threads: nothing on it sorts, advances, promotes, or leaves the active pile.
    const loose = availability(context(card(inkwellDeck(inkwellThreads()), "loose")));
    expect([loose.advance.on, loose.promote.on, loose.promote.why, loose.hold.on, loose.hold.why, loose.accept.on]).toEqual([false, false,
      "only a service card promotes", false, "this card stays active", false]);
    // u goes to the first service card, while one exists.
    expect([sorting.services.on, availability(context(folio, { service: null })).services.why]).toEqual([true, "every PR is in an effort"]);
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
    const chips = stripChips(view.active.map((item) => item.id), cards, SHELF);
    const items = paletteItems(availability(context(cards.get(SHELF)!)), chips, { held: [{ id: "effort-gift-cards", name: "Gift cards" }],
      done: [{ id: "effort-store-hours", name: "Store hours", archived: false }, { id: "effort-old", name: "Old", archived: true }] }, SHELF, true);
    expect(items.filter((item) => item.action).map((item) => item.key)).toEqual(DECK_ACTIONS.filter((action) => action.id !== "jump").map((action) => action.id));
    expect(items.filter((item) => item.target).map((item) => [item.title, item.keys.join(""), item.on])).toEqual([["Go to Shelf order", "1", false],
      ["Go to Store pickup", "2", true], ["Go to One-offs", "3", true], ["Go to folio · service", "4", true], ["Go to atlas · service", "5", true],
      ["Go to catalog · service", "6", true], ["Resume Gift cards", "", true], ["Reopen Store hours", "", true], ["Reopen Old", "", false]]);
  });
});
