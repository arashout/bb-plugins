import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DeckView } from "./deck.js";
import { inkwellDeck, INVENTORY_EFFORTS, INVENTORY_NOW as NOW } from "./inkwell-fixtures.js";
import { availability, cardScreen, hintKeys, paletteItems, stripChips, uncScreen, type Accepted, type CardScreen, type KeyContext } from "./deck-view-model.js";
import { ConfirmBody, DeckPane, HelpBody, PaletteBody, SeedBody, type ConfirmPlan, type DeckPaneProps } from "./deck-screen.js";
import type { SeedProposal } from "./linear-seed.js";

const SHELF = INVENTORY_EFFORTS.shelf.id, ONE_OFFS = "effort-one-offs";
const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
const noop = () => {};
const none = { rows: {}, at: {} };
const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/&quot;/gu, '"').replace(/&#x27;/gu, "'").replace(/&amp;/gu, "&").replace(/\s+/gu, " ");

function pane(view: DeckView, cur: string, patch: Partial<DeckPaneProps> = {}, accepted: Accepted = new Map()) {
  const cards = new Map(view.active.map((item) => [item.id, cardScreen(item, none, { now: NOW })]));
  const unc = uncScreen(view, none, accepted, { now: NOW });
  const card = cards.get(cur) ?? null;
  const context: KeyContext = { view: "deck", cur: card ?? "unc", focused: null, selected: [], seenAvailable: false, undo: false, held: 1, done: 1 };
  const on = availability(context);
  return renderToStaticMarkup(createElement(DeckPane, {
    chips: stripChips(view.active.map((item) => item.id), cards, { toSort: unc.coverage.toSort, changed: unc.changed }, cur), cur, card, unc: card ? null : unc,
    rules: [{ id: "r1", text: "Branch shelf/* → Shelf order · 2 this week" }], held: [{ id: "effort-gift-cards", key: "effort-gift-cards", name: "Gift cards", note: "Waiting on the card vendor" }],
    done: [{ id: "effort-store-hours", key: "effort-store-hours", name: "Store hours", note: "0 merged" }], read: { text: "Read 25s ago", error: null },
    seen: { changed: 0, available: false, note: null }, state: { selected: new Set<string>(), expanded: new Set<string>(), focus: null }, tiles: new Set<string>(), open: new Set<string>(), pile: null, stuck: false,
    on, hints: hintKeys(context, on), flash: null, batch: { kinds: [] }, run: noop, onPalette: noop, onHelp: noop, onUndo: noop, ...patch }));
}
/** A button's text and whether it's disabled, by its data-deck-focus id. */
const button = (html: string, focus: string) => {
  const match = new RegExp(`<button[^>]*data-deck-focus="${focus}"([^>]*)>(.*?)</button>`, "u").exec(html)!;
  return { text: text(match[2]!).trim(), disabled: /aria-disabled="true"/u.test(match[0]!) };
};
const section = (html: string, key: string) => {
  const start = html.indexOf(`data-deck-sec="${key}"`);
  const end = html.indexOf("data-deck-sec=", start + 20);
  return html.slice(start, end === -1 ? undefined : end);
};

describe("the effort deck's markup", () => {
  it("draws the strip in session order with each card's number, color dot, and Needs you, Unclassified last with what's to sort, and both piles", () => {
    const html = pane(inkwellDeck(), SHELF);
    const chips = [...html.matchAll(/data-deck-chip="([^"]+)"[^>]*>(.*?)<\/button>/gu)].map((match) => text(match[2]!).trim());
    expect(chips).toEqual(["1 Shelf order 5", "2 Store pickup 3", "3 One-offs 3", "4 Unclassified 4"]);
    expect(html).toMatch(/data-deck-chip="effort-shelf-order" aria-current="true"/u);
    expect(text(html)).toContain("Hold 1");
    expect(text(html)).toContain("Done 1");
  });

  it("gives the card its header actions with their keys, then one section per move with one batch button, and none for code work", () => {
    const html = pane(inkwellDeck(), SHELF);
    expect(text(html)).toMatch(/Shelf order 5 need you · 1 in flight|Shelf order 5 need you/u);
    expect(button(html, "act-advance")).toEqual({ text: "Advance a", disabled: true });
    expect(button(html, "act-hold")).toEqual({ text: "Hold h", disabled: false });
    expect(text(section(html, "merge"))).toContain("Merge 4 ? Preview merge m");
    expect(section(html, "work")).not.toContain("data-deck-focus=\"sec-work\"");
    expect(text(section(html, "work"))).toContain("Work on folio #330 ↗");
  });

  it("offers Advance and a button per safe section on One-offs, but no Hold or Complete, which One-offs never takes", () => {
    const html = pane(inkwellDeck(), ONE_OFFS);
    expect(button(html, "act-advance")).toEqual({ text: "Advance · 3 a", disabled: false });
    expect(html).not.toContain("act-hold");
    expect(text(section(html, "confirm"))).toContain("Confirm review notes 2 ? Confirm… c");
    expect(text(section(html, "nudge"))).toContain("Nudge reviewers 1 ? Nudge… n");
  });

  it("dims a row you acted on in place, with Undo while its batch waits", () => {
    const view = inkwellDeck({}, (row) => row.number === 96 ? { acted: { kind: "nudge", state: "queued", at: NOW, batchId: "b-1" } } : {});
    const nudge = section(pane(view, ONE_OFFS), "nudge");
    expect(text(nudge)).toContain("Nudging… Undo");
    expect(nudge).toMatch(/aria-label="catalog #96 ABC-121 Show series order on catalog pages, settled on Mark seen"/u);
    // Its section's button goes quiet: the only row it would take is waiting on its batch.
    expect(nudge).toMatch(/data-deck-focus="sec-nudge" aria-disabled="true"/u);
  });

  it("says on the row when its last read failed", () => {
    const view = inkwellDeck({}, (row) => row.number === 340 ? { failure: { at: new Date(NOW - 3_600_000).toISOString(), error: "timeout" } } : {});
    const row = section(pane(view, SHELF), "merge").split("data-deck-row=").find((part) => part.includes("folio/pull/340"))!;
    expect(text(row)).toContain("read failed");
  });

  it("draws every tile with its summary and a More only where there's more", () => {
    const html = pane(inkwellDeck(), SHELF);
    const tiles = [...html.matchAll(/data-deck-tile="([a-z]+)"/gu)].map((match) => match[1]);
    expect(tiles).toEqual(["next", "blocked", "stats", "threads", "linear", "people", "recent"]);
    expect(text(html)).toContain("Blocked Nothing waits on others.");
    // Closed, the Linear tile summarizes itself on a narrow card and lays its chips and state bar out on one line on a wide one, as the mock does.
    const tile = (from: string) => from.slice(from.indexOf('data-deck-tile="linear"'), from.indexOf('data-deck-tile="people"'));
    expect(text(tile(html))).toContain("Linear Shelf redesign More ▣ Shelf redesign #shelves");
    expect(tile(html)).toContain('class="@min-[700px]:hidden">Shelf redesign<');
    expect(tile(html)).toMatch(/data-deck-linear-line="true" class="[^"]*hidden @min-\[700px\]:flex"/u);
    expect(tile(html)).toContain('aria-label="Tickets: 1 In Review"');
    // Opened, it keeps that line at any width and adds one line per field Linear gave; a card with none says so rather than looking empty.
    const linear = tile(pane(inkwellDeck(), SHELF, { tiles: new Set(["linear"]) }));
    expect(text(linear)).toContain("Linear Less ▣ Shelf redesign #shelves States 1 in review Read 1 of 5 tickets");
    expect(linear).toMatch(/data-deck-linear-line="true" class="[^"]*mb-1.5 flex"/u);
    expect(text(pane(inkwellDeck(), "effort-store-pickup"))).toContain("Linear no Linear data People");
  });

  it("draws the Unclassified deck: coverage, rules, and each suggestion's reason once with its one button and each PR's signals", () => {
    const html = pane(inkwellDeck(), "unc");
    expect(text(html)).toContain("Effort coverage 59% of 17 open PRs are in a real effort");
    expect(text(html)).toContain("10 in efforts 3 one-offs 4 to sort");
    expect(text(html)).toContain("Branch shelf/* → Shelf order · 2 this week");
    const group = text(section(html, `effort:${SHELF}:high`));
    expect(group).toContain("→ Shelf order Shared ticket · same ticket prefix high Put 1 in Shelf order p");
    expect(group).toContain("folio #325 ABC-355 Remember the last shelf you browsed ticket ABC-355 prefix ABC Conflicts");
    expect(group.match(/Shared ticket · same ticket prefix/gu)).toHaveLength(1);
    expect(text(section(html, "new:ABC-210"))).toContain("→ new Delivery windows");
    expect(text(section(html, "none"))).toContain("No clear signal Pick an effort for each PR. Pick per PR e");
    expect(button(html, "seed")).toEqual({ text: "Seed from Linear…", disabled: false });
  });

  // Seeding is two explicit clicks: nothing is checked when the preview opens, and a project Create would skip can't be checked: one whose PRs
  // all have an effort, or one an effort has the name of.
  it("previews Linear projects with what each takes and what it may duplicate, and creates only what you check", () => {
    const prUrl = (number: number) => url("folio", number);
    const pr = (number: number, effort: SeedProposal["prs"][number]["effort"]) => ({ prUrl: prUrl(number), repo: "inkwell/folio", number, title: `Change ${number}`,
      tickets: [`ABC-${number}`], effort });
    const shelf = { id: SHELF, name: "Shelf order" };
    const proposals: SeedProposal[] = [
      { projectId: "proj-lists", name: "Reading lists", goal: "Readers keep lists of books to read next.", prs: [pr(313, null), pr(320, shelf), pr(321, shelf)],
        matches: [{ ...shelf, by: "members", prs: 2 }] },
      { projectId: "proj-shelves", name: "Shelf order", goal: "", prs: [pr(316, shelf)], matches: [{ ...shelf, by: "name", prs: 1 }] },
      { projectId: "proj-pickup", name: "Store pickup", goal: "", prs: [pr(322, null)], matches: [{ id: "effort-store-pickup", name: "Store pickup", by: "name", prs: 0 }] }];
    const body = (picked: string[]) => renderToStaticMarkup(createElement(SeedBody, { proposals, keyed: true, picked: new Set(picked), busy: false, error: null,
      onPick: noop, onCreate: noop, onCancel: noop }));
    const html = body([]);
    expect(text(html)).toContain("Reading lists Readers keep lists of books to read next. Shelf order owns 2 of its PRs takes 1 of 3 PRs");
    expect(text(html)).toContain("Shelf order Shelf order has its name already exists");
    expect(text(html)).toContain("Store pickup Store pickup has its name already exists");
    expect(html.match(/type="checkbox"/gu)).toHaveLength(3);
    expect(html).not.toMatch(/checked=""/u);
    expect(html.match(/disabled=""/gu)).toHaveLength(3);
    expect(text(body(["proj-lists"]))).toContain("Create 1 effort ⌘↵");
    expect(text(renderToStaticMarkup(createElement(SeedBody, { proposals: [], keyed: false, picked: new Set<string>(), busy: false, error: null, onPick: noop,
      onCreate: noop, onCancel: noop })))).toContain("No Linear API key is set.");
  });

  it("collapses a group to one line with Undo once you accepted all of it, and keeps drawing what a partial accept left to sort", () => {
    const view = inkwellDeck({}, (row) => row.number === 305 || row.number === 410 ? { effort: { id: ONE_OFFS, name: "One-offs" } } : {});
    const html = pane(view, "unc", {}, new Map([["none", { actionId: "a1", text: "1 PR → One-offs", prUrls: [url("folio", 305)] }],
      ["new:ABC-210", { actionId: "a2", text: "1 PR → One-offs", prUrls: [url("atlas", 410)] }]]));
    expect(text(section(html, "none"))).toContain("✓ 1 PR → One-offs Undo");
    expect(section(html, "none")).not.toContain("data-deck-row");
    // Only atlas #410 of Delivery windows moved: catalog #97 is still there to sort, with the group's button.
    expect(text(section(html, "new:ABC-210"))).toContain("catalog #97 ABC-122 Merge duplicate author records");
    expect(button(html, "group-new:ABC-210")).toEqual({ text: "New effort from 1… p", disabled: false });
  });

  it("sizes rows, the hint bar, and the top bar by the pane's width, never the window's, so a narrow pane on a wide screen keeps its titles", () => {
    const view = inkwellDeck({}, (row) => row.number === 210 ? { hold: { reason: "Vendor first", heldAt: NOW - 3_600_000 } } : {});
    const html = pane(view, INVENTORY_EFFORTS.pickup.id);
    expect(html).not.toMatch(/(?:^|[\s"])(?:sm|md|lg|xl):/u);
    expect(html).toMatch(/data-deck-scroller="true" class="@container/u);
    // What a fix needs stays at every width; who approved a merge drops below 720 px.
    const shelf = pane(inkwellDeck(), SHELF);
    expect(section(shelf, "work")).toMatch(/<span class="shrink-0 whitespace-nowrap text-\[11\.5px\] rounded[^"]*">Conflicts<\/span>/u);
    expect(section(shelf, "merge")).toMatch(/class="shrink-0 whitespace-nowrap text-\[11\.5px\] hidden @min-\[720px\]:inline[^"]*">✓ @mira-l/u);
    expect(section(shelf, "work")).toContain('<span class="hidden @min-[720px]:inline">Work on folio #330 </span>↗');
    // Store pickup waits on three things: a card under 700 px wide shows two, with More for the third.
    const blocked = html.slice(html.indexOf('data-deck-tile="blocked"'), html.indexOf('data-deck-tile="stats"'));
    expect(blocked.match(/@max-\[700px\]:hidden/gu)).toHaveLength(1);
    expect(blocked).toMatch(/data-deck-focus="tile-blocked"[^>]*@min-\[700px\]:hidden/u);
  });
});

describe("the deck's dialogs", () => {
  const plan: ConfirmPlan = { title: "Nudge reviewers · One-offs", sub: "", verb: "Nudge", request: false, excluded: "Not included: merges (m) and thread work.",
    items: [{ prUrl: "u1", ref: "catalog #96", title: "Show series order", kind: "nudge", what: "Nudge @mira-l", notes: 0 },
      { prUrl: "u2", ref: "folio #301", title: "Show spine labels", kind: "confirm", what: "Confirm 1 comment handled", notes: 1 }],
    skipped: [{ prUrl: "u3", ref: "folio #318", reason: "On hold. Release it first." }] };

  it("lists each PR's write and every PR it leaves out before anything is sent, and names the 8 s Undo window", () => {
    const html = renderToStaticMarkup(createElement(ConfirmBody, { plan, busy: false, error: null, reviewer: "", dirty: false, onReviewer: noop, onReplan: noop,
      onConfirm: noop, onCancel: noop }));
    expect(text(html)).toContain("Nudge @mira-l catalog #96 Show series order");
    expect(text(html)).toContain("Confirm 1 comment handled folio #301 Show spine labels");
    expect(text(html)).toContain("Left out: folio #318 On hold. Release it first.");
    expect(text(html)).toContain("Sends after 8 s · Undo until then");
    expect(html).toMatch(/data-deck-confirm[^>]*>Nudge 2<kbd[^>]*>⌘↵<\/kbd>/u);
    // A request can ask someone else instead, which plans again rather than sending.
    expect(renderToStaticMarkup(createElement(ConfirmBody, { plan: { ...plan, request: true }, busy: false, error: null, reviewer: "", dirty: false, onReviewer: noop,
      onReplan: noop, onConfirm: noop, onCancel: noop }))).toContain("Plan again");
  });

  it("won't send a request listing someone other than the reviewer you typed until it plans again", () => {
    const html = renderToStaticMarkup(createElement(ConfirmBody, { plan: { ...plan, request: true }, busy: false, error: null, reviewer: "dana", dirty: true,
      onReviewer: noop, onReplan: noop, onConfirm: noop, onCancel: noop }));
    expect(html).toMatch(/<button type="button" data-deck-confirm="true" disabled=""/u);
    expect(text(html)).toContain("Plan again first");
  });

  it("lists every action in ⌘K with its key and why a grayed one can't run, and groups the keys in ?", () => {
    const view = inkwellDeck();
    const card: CardScreen = cardScreen(view.active.find((item) => item.id === SHELF)!, none, { now: NOW });
    const on = availability({ view: "deck", cur: card, focused: null, selected: [], seenAvailable: false, undo: false, held: 1, done: 1 });
    const items = paletteItems(on, [], { held: [], done: [] }, SHELF, true);
    const palette = text(renderToStaticMarkup(createElement(PaletteBody, { query: "", items, highlight: 0, onQuery: noop, onRun: noop, onHighlight: noop })));
    expect(palette).toContain("Preview merge… m");
    expect(palette).toContain("Nudge reviewers… · no nudge is due n");
    expect(palette).toContain("Seed efforts from Linear…");
    expect(palette).toContain(`${items.filter((item) => item.on).length} of ${items.length} available here`);
    const help = text(renderToStaticMarkup(createElement(HelpBody, { items })));
    for (const group of ["Deck", "Card", "Act", "Rows", "Unclassified", "Anywhere"]) expect(help).toContain(group);
    expect(help).toContain("Merges run only from the fresh preview, on a click or ⌘↵.");
  });
});
