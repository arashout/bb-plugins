import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConfirmRead } from "./approval-evidence.js";
import type { DeckView } from "./deck.js";
import { inkwellDeck, inkwellSuggestions, inkwellThreads, INVENTORY_EFFORTS, INVENTORY_NOW as NOW } from "./inkwell-fixtures.js";
import { availability, cardScreen, cardSnapshot, hintKeys, overviewScreen, paletteItems, stripChips, type Accepted, type CardScreen, type KeyContext } from "./deck-view-model.js";
import { ConfirmBody, DeckPane, HelpBody, NotesBody, PaletteBody, RuleBody, SeedBody, WeakBody, type ConfirmPlan, type DeckPaneProps } from "./deck-screen.js";
import { notesScreen } from "./deck-view-model.js";
import type { SeedProposal } from "./linear-seed.js";

const SHELF = INVENTORY_EFFORTS.shelf.id, ONE_OFFS = "effort-one-offs", FOLIO = "service:inkwell/folio", CATALOG = "service:inkwell/catalog";
const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
const noop = () => {};
const none = { rows: {}, at: {} };
const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/&quot;/gu, '"').replace(/&#x27;/gu, "'").replace(/&amp;/gu, "&").replace(/\s+/gu, " ");

function pane(view: DeckView, cur: string, patch: Partial<DeckPaneProps> = {}, accepted: Accepted = new Map()) {
  const cards = new Map(view.active.map((item) => [item.id, cardScreen(item, none, { now: NOW, accepted })]));
  const card = cards.get(cur) ?? null;
  const context: KeyContext = { view: "deck", cur: card ?? (cur === "overview" ? "overview" : null), service: FOLIO, focused: null, selected: [], seenAvailable: false,
    undo: false, held: 1, done: 1 };
  const on = availability(context);
  return renderToStaticMarkup(createElement(DeckPane, {
    chips: stripChips(view.active.map((item) => item.id), cards, cur), cur, card,
    overview: cur === "overview" ? overviewScreen(view.active.map((item) => item.id), cards) : null,
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
  it("draws the strip in session order with each card's number, color dot, and Needs you, the service cards last and dashed, and both piles", () => {
    const html = pane(inkwellDeck(), SHELF);
    const chips = [...html.matchAll(/data-deck-chip="([^"]+)"[^>]*>(.*?)<\/button>/gu)].map((match) => text(match[2]!).trim());
    expect(chips).toEqual(["Overview", "1 Shelf order 5", "2 Store pickup 3", "3 One-offs 3", "4 folio · service 2", "5 atlas · service 1", "6 catalog · service 1"]);
    expect(html).toMatch(/data-deck-chip="service:inkwell\/folio" title="folio · service: 2 need you \(4\)" class="[^"]*border-dashed/u);
    expect(html).toMatch(/data-deck-chip="effort-shelf-order" aria-current="true"/u);
    expect(text(html)).toContain("Hold 1");
    expect(text(html)).toContain("Done 1");
  });

  it("shows peer summary panels and one navigable button per active effort", () => {
    const html = pane(inkwellDeck(), "overview");
    expect(html).toContain('data-deck-focus="heading"');
    expect(text(html)).toContain("Action matrix");
    expect(text(html)).toContain("Aging blockers");
    expect(text(html)).toContain("Store pickup · quill #212");
    expect(html.match(/data-deck-focus="overview-effort-/gu)).toHaveLength(3);
    expect(html).not.toContain("data-deck-card");
    expect(html).not.toContain("data-deck-sec=");
    expect(html).not.toContain('data-deck-focus="seen"');
  });

  it("uses one PR-count scale across Action matrix efforts and names the scale and colors", () => {
    const view = inkwellDeck();
    const cards = view.active.slice(0, 2).map((item, index) => ({ ...cardScreen(item, none, { now: NOW }), needsYou: 0, blocked: [],
      stats: { ...cardScreen(item, none, { now: NOW }).stats, bar: [{ key: "fix", label: "Fix", count: index ? 4 : 2, tone: "amber" as const }] } }));
    const html = pane(view, "overview", { overview: { cards, blockers: [] } });
    expect(text(html)).toContain("0–4 PRs");
    expect(text(html)).toContain("Your other moves");
    expect(text(html)).toContain("Waiting");
    expect(html).toMatch(/aria-label="2 Fix"/u);
    expect(html).toMatch(/aria-label="4 Fix"/u);
    const widths = [...html.matchAll(/class="h-full shrink-0 bg-amber-500\/60" style="width:([^"]+)"/gu)].map((match) => match[1]);
    expect(widths).toEqual(["50%", "100%"]);
  });

  it("keeps the action matrix compact while every active effort still has a card", () => {
    const view = inkwellDeck();
    const first = view.active[0]!;
    const active = [...view.active, ...[1, 2, 3].map((number) => ({ ...first, id: `extra-${number}`, name: `Extra effort ${number}` }))];
    const html = pane({ ...view, active }, "overview");
    expect(html.match(/data-deck-focus="overview-matrix-/gu)).toHaveLength(5);
    expect(html.match(/data-deck-focus="overview-effort-/gu)).toHaveLength(6);
    expect(text(html)).toContain("1 more effort below");
  });

  it("shows an empty Overview without presenting a service card's content", () => {
    const html = pane({ ...inkwellDeck(), active: [] }, "overview");
    expect(text(html)).toContain("No active efforts yet.");
    expect(text(html)).toContain("Nothing waits on others.");
    expect(html).not.toContain("Effort coverage");
    // Service cards alone are no efforts: Overview stays empty and draws none of their rows or suggestions.
    const services = pane({ ...inkwellDeck(), active: inkwellDeck().active.filter((item) => item.kind !== "effort") }, "overview");
    expect(text(services)).toContain("No active efforts yet.");
    expect(services).not.toContain("data-deck-sec=");
    expect(services).not.toContain("data-deck-row=");
  });

  it("keeps the loading message until the first deck read supplies Overview", () => {
    const html = pane({ ...inkwellDeck(), active: [] }, "overview", { overview: null });
    expect(text(html)).toContain("Reading your efforts…");
    expect(html).not.toContain("No active efforts yet.");
  });

  it("keeps every row's PR number outside the part that truncates, so a long repo name never hides it", () => {
    const html = pane(inkwellDeck(), SHELF);
    const truncated = [...html.matchAll(/<span class="min-w-0 truncate">([^<]*)<\/span>/gu)].map((match) => match[1]!);
    expect(truncated.length).toBeGreaterThan(0);
    for (const repo of truncated) expect(repo).not.toMatch(/#\d/u);
    expect(html).toMatch(/class="flex w-\[124px\] shrink-0 justify-start gap-1 whitespace-nowrap/u);
    expect(html).toMatch(/<b class="shrink-0 font-medium[^"]*">#\d+<\/b>/u);
  });

  it("nests PR rows under section headings and keeps an opened thread row connected to its details", () => {
    const view = inkwellDeck();
    const closed = pane(view, SHELF);
    expect(section(closed, "work")).toMatch(/<div class="ml-7"><div data-deck-row=/u);
    // A service card's rows nest the same way.
    expect(pane(view, FOLIO)).toMatch(/<div class="ml-7"><div data-deck-row="https:\/\/github\.com\/inkwell\/folio\//u);

    const opened = section(pane(view, SHELF, { state: { selected: new Set<string>(), expanded: new Set([url("folio", 330)]), focus: null } }), "work");
    expect(opened).toMatch(/<div class="ml-7 rounded-md bg-foreground\/\[0\.035\]"><div data-deck-row="https:\/\/github\.com\/inkwell\/folio\/pull\/330"/u);
    expect(opened).toContain('class="flex min-w-12 items-center justify-end gap-1 text-[11.5px]"');
    expect(opened).toMatch(/aria-expanded="true"[^>]*class="shrink-0 [^"]*"[^>]*>Less<\/button>/u);
    expect(opened).toMatch(/aria-expanded="true"[^>]*>Less<\/button><\/span><\/div><div data-deck-details=/u);
    expect(opened).toContain('data-deck-details="https://github.com/inkwell/folio/pull/330" class="mb-1.5 ml-9 mr-1.5 grid gap-1.5 border-t');
  });

  it("gives the card its header actions with their keys, then one section per move with one batch button, code work's asking its threads", () => {
    const html = pane(inkwellDeck(), SHELF);
    expect(text(html)).toMatch(/Shelf order 5 need you · 1 in flight|Shelf order 5 need you/u);
    expect(button(html, "act-advance")).toEqual({ text: "Advance a", disabled: true });
    expect(button(html, "act-hold")).toEqual({ text: "Hold h", disabled: false });
    expect(text(section(html, "merge"))).toContain("Merge 4 ? Preview merge m");
    // Code work is each PR's thread's: its one button asks them, listing each first, and never runs under Advance.
    expect(button(section(html, "work"), "sec-work")).toEqual({ text: "Ask threads to fix (1) f", disabled: false });
    expect(text(section(html, "work"))).toContain("Work on folio #330 ↗");
  });

  it("offers Advance and a button per safe section on One-offs, but no Hold or Complete, which One-offs never takes", () => {
    const html = pane(inkwellDeck(), ONE_OFFS);
    expect(button(html, "act-advance")).toEqual({ text: "Advance · 1 a", disabled: false });
    expect(html).not.toContain("act-hold");
    // Review notes are confirmed one PR at a time: their section has no batch button.
    expect(text(section(html, "confirm"))).toContain("Confirm review notes 2 ?");
    expect(section(html, "confirm")).not.toContain('data-deck-focus="sec-confirm"');
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

  it("puts a Held chip in the header of a card with held PRs, which jumps to its Held section of each PR with why and how long", () => {
    const view = inkwellDeck({}, (row) => row.number === 211 ? { hold: { reason: "Waiting on the slip printer", heldAt: NOW - 2 * 86_400_000 } } : {});
    const html = pane(view, INVENTORY_EFFORTS.pickup.id);
    expect(button(html, "held")).toEqual({ text: "Held · 1 ⇧H", disabled: false });
    const held = section(html, "held");
    expect(text(held)).toContain("Held 1 ?");
    expect(text(held)).toContain("quill #211 ABC-371 Print hold slips Waiting on the slip printer 2d Release l");
    expect(button(html, "sec-held")).toEqual({ text: "Release… l", disabled: false });
    // A paused card still releases: a release writes nothing to GitHub.
    const pickup = view.active.find((item) => item.id === INVENTORY_EFFORTS.pickup.id)!;
    const paused = pane(view, pickup.id, { card: cardScreen({ ...pickup, pile: "held" }, none, { now: NOW }) });
    expect(button(paused, "sec-held")).toEqual({ text: "Release… l", disabled: false });
    // A card with nothing held draws no chip and no Held section.
    const shelf = pane(view, SHELF);
    expect(shelf).not.toContain('data-deck-focus="held"');
    expect(shelf).not.toContain('data-deck-sec="held"');
  });

  it("gives a row with a safe next step its own Advance, shown on the row you point at or focus, and the a badge only where a acts", () => {
    const nudge = section(pane(inkwellDeck(), ONE_OFFS), "nudge");
    // A hovered row's Advance is a click, not a: only the focused row's badge shows, as a takes that row alone.
    expect(nudge).toMatch(/<button type="button" tabindex="-1" data-deck-inline="advance" title="Nudge @mira-l @theo-k: lists it, then sends in 8 s with Undo \(a\)" class="[^"]*opacity-0 group-hover:opacity-100 group-focus-within:opacity-100[^"]*">Advance<span class="hidden group-focus-within:inline-flex"><kbd[^>]*>a<\/kbd><\/span><\/button>/u);
    // A selection takes a, so a row you select keeps its Advance click but loses the badge, even while it holds focus.
    const badges = (html: string) => [...html.matchAll(/data-deck-inline="advance"[^>]*>(.*?)<\/button>/gu)].map((match) => match[1]!.includes("<kbd"));
    const focus = { expanded: new Set<string>(), focus: url("catalog", 96) };
    expect(badges(pane(inkwellDeck(), ONE_OFFS, { state: { ...focus, selected: new Set<string>() } }))).toEqual([true]);
    expect(badges(pane(inkwellDeck(), ONE_OFFS, { state: { ...focus, selected: new Set([url("catalog", 96)]) } }))).toEqual([false]);
    // The card's Advance keeps its badge only while a takes the card; a focused row or a selection takes it instead.
    expect(button(pane(inkwellDeck(), ONE_OFFS, { advanceScope: "card" }), "act-advance").text).toBe("Advance · 1 a");
    for (const scope of ["row", "selected"] as const) {
      expect(button(pane(inkwellDeck(), ONE_OFFS, { advanceScope: scope }), "act-advance").text).toBe("Advance · 1");
      expect(button(pane(inkwellDeck(), ONE_OFFS, { advanceScope: scope, stuck: true }), "act-advance").text).toBe("Advance · 1");
    }
    // Review notes have no Advance: their row opens its notes, one PR at a time.
    expect(section(pane(inkwellDeck(), ONE_OFFS), "confirm")).not.toContain('data-deck-inline="advance"');
    expect([...section(pane(inkwellDeck(), ONE_OFFS), "confirm").matchAll(/data-deck-inline="confirm"[^>]*>Notes…/gu)]).toHaveLength(2);
    // A merge row has none: merges stay in the preview.
    expect(section(pane(inkwellDeck(), SHELF), "merge")).not.toContain("data-deck-inline");
  });

  it("keeps a row a read moved where it was, linking to where it lands, which holds its place, and a merged row as one ghost line", () => {
    const shelf = (view: DeckView) => view.active.find((item) => item.id === SHELF)!;
    const seen = { rows: { [SHELF]: cardSnapshot(shelf(inkwellDeck())) }, at: {} };
    const after = inkwellDeck({}, (row) => row.number === 342 ? { attention: [], status: "Awaiting review", stage: "review" } : row.number === 341 ? { effort: null } : {});
    const screen = cardScreen(shelf(after), seen, { now: NOW, gone: new Map([[url("folio", 341), { how: "merged", at: NOW - 10_000 }]]) });
    const html = pane(after, SHELF, { card: screen });
    const merge = section(html, "merge");
    const row = (number: number) => merge.split("data-deck-row=").find((part) => part.startsWith(`"${url("folio", number)}"`))!;
    expect(text(row(341))).toContain("folio #341 ABC-361 Read shelf order back Merged · just now");
    expect(row(341)).toContain("line-through");
    // #343 still waits on #342, which moved to In flight: each says what changed and links where it goes.
    expect(text(row(342))).toContain("Behind #341 → Awaiting review → moved to In flight ↓");
    expect(row(343)).toMatch(/<button type="button" tabindex="-1" data-deck-to="blocked" title="It moves to Blocked on Mark seen. Show where."[^>]*>→ moved to Blocked ↓<\/button>/u);
    // Blocked holds #343's place, so the link has somewhere to land; the row itself is drawn once, where you saw it.
    expect(text(section(html, "blocked"))).toContain("folio #343 lands here on Mark seen");
    expect(html.match(new RegExp(`data-deck-row="${url("folio", 343)}"`, "gu"))).toHaveLength(1);
  });

  // Ready on your word alone never reads as checked: the merge row says so where it would name the approvers.
  it("says a merge row is confirmed by you with no check ran, in place of its approvers", () => {
    const row = (html: string) => section(html, "merge").split("data-deck-row=").find((part) => part.startsWith(`"${url("folio", 340)}"`))!;
    const confirmed = inkwellDeck({}, (item) => item.number === 340 ? { confirmation: { at: NOW, current: true, evidence: false } } : {});
    expect(text(row(pane(confirmed, SHELF)))).toContain("Ready · your word");
    expect(text(row(pane(inkwellDeck(), SHELF)))).not.toContain("Ready · your word");
    // Once a later head leaves it behind, it no longer speaks for the row.
    const stale = inkwellDeck({}, (item) => item.number === 340 ? { confirmation: { at: NOW, current: false, evidence: false } } : {});
    expect(text(row(pane(stale, SHELF)))).not.toContain("Ready · your word");
  });

  it("offers Revoke confirmation in the details of a row carrying your confirmation, and only there", () => {
    const pr340 = url("folio", 340);
    const expanded = { state: { selected: new Set<string>(), expanded: new Set([pr340]), focus: null } };
    const confirmed = inkwellDeck({}, (row) => row.number === 340 ? { confirmation: { at: NOW, current: true, evidence: false } } : {});
    expect(pane(confirmed, SHELF, expanded)).toMatch(/<button type="button" data-deck-revoke[^>]*>Revoke confirmation<\/button>/u);
    expect(pane(inkwellDeck(), SHELF, expanded)).not.toContain("data-deck-revoke");
  });

  it("offers Move to One-offs in an effort's row details and selection bar, and nowhere on One-offs or a service card", () => {
    const open = (id: string, prUrl: string) => pane(inkwellDeck(), id, { state: { selected: new Set([prUrl]), expanded: new Set([prUrl]), focus: null } });
    const shelf = open(SHELF, url("folio", 340));
    expect(shelf).toMatch(/<button type="button" data-deck-one-off="true"[^>]*title="Moves it out of this effort; Undo puts it back">Move to One-offs<\/button>/u);
    expect(shelf.slice(shelf.indexOf('aria-label="Selection"'))).toContain(">Move to One-offs</button>");
    for (const [id, prUrl] of [[ONE_OFFS, url("folio", 301)], [FOLIO, url("folio", 325)]] as const) expect(open(id, prUrl)).not.toContain("Move to One-offs");
  });

  it("puts Refresh on each row, shown on the row you point at, and spins it in sight while GitHub reads the PR", () => {
    const pr340 = url("folio", 340);
    const idle = section(pane(inkwellDeck(), SHELF), "merge").split("data-deck-row=").find((part) => part.startsWith(`"${pr340}"`))!;
    expect(idle).toMatch(/<button type="button" tabindex="-1" data-deck-refresh="idle" aria-label="Refresh folio #340 from GitHub" title="Refresh from GitHub" class="[^"]*opacity-0 group-hover:opacity-100[^"]*"><span aria-hidden="true" class="inline-block leading-none">↻<\/span><\/button>/u);
    const html = pane(inkwellDeck(), SHELF, { state: { selected: new Set(), expanded: new Set([pr340]), focus: null, refreshing: new Set([pr340]) } });
    const busy = section(html, "merge").split("data-deck-row=").find((part) => part.startsWith(`"${pr340}"`))!;
    expect(busy).toMatch(/data-deck-refresh="busy" aria-busy="true" aria-label="Reading folio #340 from GitHub" title="Reading GitHub now…" class="(?![^"]*opacity-0)[^"]*"><span aria-hidden="true" class="inline-block leading-none motion-safe:animate-spin">↻/u);
    // Its details say so too, and won't start a second read.
    expect(busy).toMatch(/<button type="button" aria-busy="true" disabled=""[^>]*><span[^>]*motion-safe:animate-spin">↻<\/span>Refreshing…<\/button>/u);
    // A ghost has nothing left to read.
    const seen = { rows: { [SHELF]: cardSnapshot(inkwellDeck().active.find((item) => item.id === SHELF)!) }, at: {} };
    const after = inkwellDeck({}, (row) => row.number === 341 ? { effort: null } : {});
    const ghost = section(pane(after, SHELF, { card: cardScreen(after.active.find((item) => item.id === SHELF)!, seen, { now: NOW }) }), "merge")
      .split("data-deck-row=").find((part) => part.startsWith(`"${url("folio", 341)}"`))!;
    expect(ghost).not.toContain("data-deck-refresh");
  });

  it("says on the row when its last read failed", () => {
    const view = inkwellDeck({}, (row) => row.number === 340 ? { failure: { at: new Date(NOW - 3_600_000).toISOString(), error: "timeout" } } : {});
    const row = section(pane(view, SHELF), "merge").split("data-deck-row=").find((part) => part.includes("folio/pull/340"))!;
    expect(text(row)).toContain("read failed");
  });

  it("draws every tile with its summary and a More only where there's more", () => {
    const html = pane(inkwellDeck(), SHELF);
    const tiles = [...html.matchAll(/data-deck-tile="([a-z]+)"/gu)].map((match) => match[1]);
    expect(tiles).toEqual(["next", "blocked", "stats", "notes", "threads", "linear", "people", "recent"]);
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

  // Notes are a stopgap for what the card doesn't track yet: one line until you open them, bb's Markdown once you do, and edited in place.
  it("makes the header's need-you and blocked counts buttons that show those rows alone, with a line that shows all again", () => {
    const html = pane(inkwellDeck(), "effort-store-pickup");
    expect(html).toMatch(/<button type="button" data-deck-focus="count-needs" aria-pressed="false" title="Show only these 3"[^>]*>3 need you<\/button>/u);
    expect(html).toMatch(/<button type="button" data-deck-focus="count-blocked" aria-pressed="false" title="Show only these 2"[^>]*>2 blocked<\/button>/u);
    expect(html).not.toContain("data-deck-filter");
    const view = inkwellDeck();
    const full = cardScreen(view.active.find((item) => item.id === "effort-store-pickup")!, none, { now: NOW });
    const cut = { ...full, sections: full.sections.filter((section) => section.key === "blocked") };
    const filtered = pane(view, "effort-store-pickup", { card: cut, filter: "blocked" });
    expect(filtered).toMatch(/data-deck-focus="count-blocked" aria-pressed="true" title="Show all rows \(esc\)"/u);
    expect(text(filtered)).toContain("Only what's blocked · 2 Show all esc Blocked 2");
    expect(filtered).not.toContain('data-deck-sec="work"');
  });

  it("shows an effort's notes as their first line, renders them with the Markdown it's given when opened, and edits them in place", () => {
    const body = "## Flags\n- shelf_v2 on for staff\n\nExperiment: sort by genre.";
    const view = inkwellDeck();
    const noted = { ...view, active: view.active.map((item) => item.id === SHELF ? { ...item, notes: { body, revision: 3, updatedAt: NOW } } : item) };
    const tile = (html: string) => html.slice(html.indexOf('data-deck-tile="notes"'), html.indexOf('data-deck-tile="threads"'));
    const closed = tile(pane(noted, SHELF));
    expect(text(closed)).toContain("Notes Flags Edit ⇧N More");
    expect(closed).not.toContain("data-deck-notes-body");
    const open = tile(pane(noted, SHELF, { tiles: new Set(["notes"]), markdown: (content) => createElement("article", { "data-md": true }, content) }));
    expect(open).toContain(`<div data-deck-notes-body="true" class="min-w-0 text-[12.5px]"><article data-md="true">${body}</article></div>`);
    const editing = tile(pane(noted, SHELF, { notes: { draft: body, busy: false, error: "These notes changed since you opened them." } }));
    expect(editing).toMatch(/<textarea data-deck-notes-editor="true"[^>]*aria-label="Notes, in Markdown"/u);
    expect(text(editing)).toContain("These notes changed since you opened them. Markdown Cancel esc Save ⌘↵");
    // Before the first save the tile says there are none; a service card has nowhere to keep them.
    expect(text(tile(pane(view, SHELF)))).toContain("Notes None yet. Edit ⇧N");
    expect(pane(view, FOLIO)).not.toContain('data-deck-tile="notes"');
  });

  // The card behind the top one is the one ] flips to, so its name on the visible edge says where the next flip lands, and clicking it goes there.
  it("stacks the next efforts behind the card, each lower, smaller, and to the right, with the next one's name on its edge", () => {
    const html = pane(inkwellDeck(), SHELF);
    const layers = [...html.matchAll(/data-deck-layer="(\d)"([^>]*)>/gu)].map((match) => `${match[1]}${/aria-hidden="true"/u.test(match[2]!) ? " hidden" : ""} ${
      /transform:([^;"]+)/u.exec(match[2]!)![1]}`);
    expect(layers).toEqual(["1 translate(3px, 16px) scale(0.98)", "2 hidden translate(6px, 22px) scale(0.96)", "3 hidden translate(9px, 27px) scale(0.94)"]);
    expect(html).toMatch(/<button type="button" tabindex="-1" data-deck-peek="effort-store-pickup" title="Next: Store pickup \(\] or →\)" aria-label="Next effort: Store pickup"/u);
    // The deepest edge's room is kept below the stack, so the sections start after it and nothing overlaps them.
    expect(html).toMatch(/<div class="mb-2.5" style="padding-bottom:27px"><div data-deck-stack="true"/u);
    expect(html.indexOf("data-deck-top")).toBeLessThan(html.indexOf('data-deck-card="effort-shelf-order"'));
    // A flip fades the rows as one, and draws the card it takes away in the ghost, which is empty until then and never read aloud. The ghost
    // spans the top card and is clipped at its bottom edge only, so a taller card taken away can't paint over the rows below.
    expect(html.indexOf("data-deck-rows")).toBeLessThan(html.indexOf("data-deck-sec="));
    expect(html).toMatch(/<div data-deck-ghost="true" aria-hidden="true" class="[^"]*\binset-0\b[^"]*" style="clip-path:inset\(-60px -60px 0 -60px\)"><\/div>/u);
    // The last effort's next card is the first service card; the last service card's wraps to Overview, which opens the ring, named without
    // a dot; a pile of two, Overview and one card, has one card behind.
    expect(html.match(/data-deck-peek="([^"]+)"/u)?.[1]).toBe("effort-store-pickup");
    expect(pane(inkwellDeck(), ONE_OFFS).match(/data-deck-peek="([^"]+)"/u)?.[1]).toBe(FOLIO);
    const last = pane(inkwellDeck(), CATALOG);
    expect(last.match(/data-deck-peek="([^"]+)"/u)?.[1]).toBe("overview");
    expect(last).toMatch(/data-deck-peek="overview" title="Next: Overview \(\] or →\)"[^>]*><span class="truncate">Overview<\/span><\/button>/u);
    const view = inkwellDeck();
    const cards = new Map(view.active.map((item) => [item.id, cardScreen(item, none, { now: NOW })]));
    const two = pane(view, SHELF, { chips: stripChips([SHELF], cards, SHELF) });
    expect(two.match(/data-deck-layer=/gu)).toHaveLength(1);
    expect(two).toMatch(/style="padding-bottom:16px"/u);
  });

  it("says the card a flip landed on in one polite status line, and nothing until then", () => {
    expect(pane(inkwellDeck(), SHELF)).toMatch(/<p role="status" data-deck-announce="true" class="sr-only"><\/p>/u);
    expect(pane(inkwellDeck(), SHELF, { announce: "Shelf order" })).toMatch(/<p role="status" data-deck-announce="true" class="sr-only">Shelf order<\/p>/u);
  });

  it("draws each pile as a tiny stack of cards, and an empty pile as an outline", () => {
    const html = pane(inkwellDeck(), SHELF, { held: [] });
    const piles = [...html.matchAll(/data-deck-pile="(\w+)"[^>]*><span aria-hidden="true" data-deck-pile-cards="(\w+)"[^>]*>(.*?)<\/span>/gu)]
      .map((match) => `${match[1]} ${match[2]} ${match[3]!.match(/<i /gu)!.length}`);
    expect(piles).toEqual(["hold empty 1", "done stacked 3"]);
    expect(html).toMatch(/data-deck-pile-cards="empty"[^>]*><i class="[^"]*border-dashed/u);
  });

  it("draws a service card as an effort's with a hollow dot, Promote in place of Hold and Complete, and its suggestions and rules above its rows", () => {
    const html = pane(inkwellDeck(), FOLIO);
    expect(html).toMatch(/data-deck-card="service:inkwell\/folio"/u);
    expect(text(html)).toContain("folio · service 2 need you Work in folio that no effort has yet.");
    expect(button(html, "act-advance")).toEqual({ text: "Advance · 2 a", disabled: false });
    expect(button(html, "act-promote")).toEqual({ text: "Promote to effort…", disabled: false });
    expect(html).not.toContain("act-hold");
    expect(html).not.toContain("act-complete");
    // Suggestions sit above the rows, which stay in their sections by the move each needs, each naming where its suggestion points.
    expect(html.indexOf("data-deck-suggest")).toBeLessThan(html.indexOf('data-deck-sec="request"'));
    expect(text(html)).toContain("Suggestions Nothing moves until you press it. Seed from Linear… + Standing rule Branch shelf/* → Shelf order · 2 this week");
    const group = text(section(html, `${FOLIO} effort:${SHELF}:high`));
    expect(group).toContain("→ Shelf order strong ticket ABC-355 · prefix ABC folio #325 Put 1 in Shelf order p");
    expect(group.match(/ticket ABC-355 · prefix ABC/gu)).toHaveLength(1);
    expect(text(section(html, `${FOLIO} none`))).toContain("No clear signal Pick an effort for each PR. folio #305 Pick per PR e");
    expect(text(section(html, "request"))).toContain("folio #325 ABC-355 Remember the last shelf you browsed → Shelf order suggest @mira-l");
    expect(button(html, "seed")).toEqual({ text: "Seed from Linear…", disabled: false });
    // An effort's card has no suggestions to draw.
    expect(pane(inkwellDeck(), SHELF)).not.toContain("data-deck-suggest");
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

  // A rule keeps placing new PRs until you remove it, so its list can't live only on a service card: once every PR is sorted there is none.
  it("lists each standing rule with its remove button in the rules dialog, which ⌘K opens from an effort's card", () => {
    const card = cardScreen(inkwellDeck().active.find((item) => item.id === SHELF)!, none, { now: NOW });
    const on = availability({ view: "deck", cur: card, focused: null, selected: [], seenAvailable: false, undo: false, held: 0, done: 0 });
    expect(paletteItems(on, [], { held: [], done: [] }, SHELF, true).find((item) => item.key === "rule")).toMatchObject({ title: "Standing rules…", on: true });
    const html = renderToStaticMarkup(createElement(RuleBody, { draft: { kind: "ticket-prefix", value: "", effortId: SHELF, now: true },
      efforts: [{ id: SHELF, name: "Shelf order" }], rules: [{ id: "r1", text: "Branch shelf/* → Shelf order · 2 this week" }], matches: null, busy: false,
      error: null, onDraft: noop, onAdd: noop, onRemove: noop, onCancel: noop }));
    expect(html).toContain('aria-label="Remove the rule Branch shelf/* → Shelf order · 2 this week"');
    expect(html.indexOf("data-deck-rules")).toBeLessThan(html.indexOf("Always put"));
  });

  it("draws a card with only threads as its header and its threads, with no action to take and a hint where each thread's effort is set", () => {
    const view = inkwellDeck(inkwellThreads());
    const loose = pane(view, "loose");
    expect([...loose.matchAll(/data-deck-tile="([a-z]+)"/gu)].map((match) => match[1])).toEqual(["threads"]);
    expect(loose).not.toContain("act-advance");
    expect(text(loose)).toContain("Loose threads No open PRs Threads with no effort or repository yet.");
    expect(text(loose)).toContain("Threads 4 Look at a flaky test");
    expect(text(loose)).toContain("Set each thread's effort from the chip above its composer.");
    const quill = pane(view, "service:inkwell/quill");
    expect(quill).not.toContain("act-promote");
    expect(quill).not.toContain("data-deck-suggest");
    expect(text(quill)).toContain("Try a quieter quill layout");
    expect(text(quill)).toContain("No open PRs here.");
  });

  it("collapses a group to one line with Undo once you accepted all of it here, and keeps drawing the rest", () => {
    const [shelf, , rest] = inkwellSuggestions();
    const view = inkwellDeck({ classify: { oneOffsId: ONE_OFFS, groups: [{ ...shelf!, prs: [...shelf!.prs, rest!.prs[0]!] }] } });
    const key = `${FOLIO} ${shelf!.key}`;
    const all = pane(view, FOLIO, {}, new Map([[key, { actionId: "a1", text: "2 PRs → Shelf order", prUrls: [url("folio", 325), url("folio", 305)] }]]));
    expect(text(section(all, key))).toContain("✓ 2 PRs → Shelf order Undo");
    expect(all).toContain(`data-deck-focus="undo-group-${key}"`);
    // Only folio #325 moved: #305 is still here, with the group's button.
    const part = pane(view, FOLIO, {}, new Map([[key, { actionId: "a1", text: "1 PR → Shelf order", prUrls: [url("folio", 325)] }]]));
    expect(button(part, `group-${key}`)).toEqual({ text: "Put 2 in Shelf order p", disabled: false });
  });

  it("sizes rows, the hint bar, and the top bar by the pane's width, never the window's, so a narrow pane on a wide screen keeps its titles", () => {
    const view = inkwellDeck({}, (row) => row.number === 210 ? { decision: { n: 1, question: "Vendor first?", since: NOW - 3_600_000 } } : {});
    const html = pane(view, INVENTORY_EFFORTS.pickup.id);
    expect(html).not.toMatch(/(?:^|[\s"])(?:sm|md|lg|xl):/u);
    expect(html).toMatch(/data-deck-scroller="true" class="@container/u);
    expect(section(html, "blocked")).toMatch(/<span title="Vendor first\?" class="min-w-0 truncate text-\[11\.5px\][^"]*">Vendor first\?<\/span>/u);
    // What a fix needs stays at every width; who approved a merge drops below 720 px.
    const shelf = pane(inkwellDeck(), SHELF);
    expect(section(shelf, "work")).toMatch(/class="min-w-16 flex-1 cursor-pointer truncate @min-\[900px\]:min-w-0/u);
    expect(section(shelf, "work")).toMatch(/<span title="Conflicts" class="min-w-0 truncate text-\[11\.5px\] rounded[^"]*">Conflicts<\/span>/u);
    expect(section(shelf, "merge")).toMatch(/class="min-w-0 truncate text-\[11\.5px\] hidden @min-\[720px\]:inline[^"]*">✓ @mira-l/u);
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

  // The deck's selection bar offers Address selected beside Advance, counting only the Your turn rows it would take, with its key.
  it("offers Address selected (N) on the deck's selection bar only when it counts Your turn rows", () => {
    const state = { selected: new Set([url("quill", 210), url("quill", 211)]), expanded: new Set<string>(), focus: null };
    const bar = (address: number) => { const html = pane(inkwellDeck(), INVENTORY_EFFORTS.pickup.id, { state, batch: { kinds: [], address } }); return html.slice(html.indexOf('aria-label="Selection"')); };
    expect(text(bar(2))).toContain("2 selected Address selected (2) b");
    expect(bar(2)).toMatch(/data-deck-address="true" title="Starts one thread for them now, with 8 s to Undo\. Nothing merges\."/u);
    expect(bar(0)).not.toContain("data-deck-address");
    // Why the last Address started nothing stays on the bar, in the server's words.
    const refused = pane(inkwellDeck(), INVENTORY_EFFORTS.pickup.id, { state, batch: { kinds: [], address: 2, refusal: "Nothing started. quill #210: On hold. Release it first." } });
    expect(refused).toMatch(/role="alert" data-deck-refusal[^>]*>Nothing started\. quill #210: On hold\. Release it first\.</u);
  });

  it("won't send a request listing someone other than the reviewer you typed until it plans again", () => {
    const html = renderToStaticMarkup(createElement(ConfirmBody, { plan: { ...plan, request: true }, busy: false, error: null, reviewer: "dana", dirty: true,
      onReviewer: noop, onReplan: noop, onConfirm: noop, onCancel: noop }));
    expect(html).toMatch(/<button type="button" data-deck-confirm="true" disabled=""/u);
    expect(text(html)).toContain("Plan again first");
  });

  it("marks a weak group, and lists each PR with its signals before a weak accept moves them", () => {
    const [shelf, ...rest] = inkwellSuggestions();
    const view = inkwellDeck({ classify: { oneOffsId: ONE_OFFS, groups: [{ ...shelf!, key: `effort:${SHELF}:low`, confidence: "low", reason: "Same code area",
      signals: ["area inkwell/folio:shelves"] }, ...rest] } });
    const group = section(pane(view, FOLIO), `${FOLIO} effort:${SHELF}:low`);
    expect(text(group)).toContain("→ Shelf order weak area inkwell/folio:shelves folio #325 Put 1 in Shelf order… p");
    expect(group).toMatch(/data-deck-strength="weak" title="weak signals" class="[^"]*text-amber-700/u);
    const lines = [{ prUrl: "u1", ref: "folio #325", title: "Remember the last shelf you browsed", signals: ["area inkwell/folio:shelves"] },
      { prUrl: "u2", ref: "folio #326", title: "Show the shelf you came from", signals: [] }];
    const html = text(renderToStaticMarkup(createElement(WeakBody, { lines, label: "Put 2 in Shelf order", busy: false, error: null, onAccept: noop, onCancel: noop })));
    expect(html).toContain("folio #325 Remember the last shelf you browsed area inkwell/folio:shelves");
    expect(html).toContain("folio #326 Show the shelf you came from No signal of its own; it goes with its group");
    expect(html).toContain("Cancel esc Put 2 in Shelf order ⌘↵");
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
    for (const group of ["Deck", "Card", "Act", "Rows", "Sort", "Anywhere"]) expect(help).toContain(group);
    expect(help).toContain("Merges run only from the fresh preview, on a click or ⌘↵.");
  });
});

describe("the review notes confirm's markup", () => {
  const read = (evidence: Partial<{ commits: number; replies: number; linked: { repo: string; number: number }[] }> = {},
    ask: Extract<ConfirmRead, { ok: true }>["ask"] = { kind: "thread", title: "Spine labels" }) =>
    notesScreen({ ok: true, headOid: "a".repeat(40), fingerprint: "f".repeat(64), ask, evidence: { since: new Date(NOW - 2 * 86_400_000).toISOString(), commits: 0, replies: 0,
      threads: { total: 0, resolved: 0 }, complete: true, ...evidence },
    sources: [{ id: "review-301", kind: "review", author: "mira-l", at: new Date(NOW - 2 * 86_400_000).toISOString(),
      body: "Ship it, but wrap spine labels at 40 characters.", truncated: false, resolved: null }] }, NOW);
  const body = (screen: ReturnType<typeof read> | null, failed: string | null = null) => renderToStaticMarkup(createElement(NotesBody, { screen, failed, busy: false,
    error: null, onConfirm: noop, onAnyway: noop, onAsk: noop, onCancel: noop }));

  // The live case that read as ready: the note sat in the approval's body, and nothing came after it.
  it("shows the approval's note and says plainly that nothing since shows it handled, leading with Ask and never a one-key confirm", () => {
    const html = body(read());
    expect(text(html)).toContain("@mira-l · review · 2d Ship it, but wrap spine labels at 40 characters.");
    expect(text(html)).toContain("No commits, reply, or resolved threads since this approval");
    expect(html).toMatch(/data-notes-ask[^>]*>Ask its thread to address it<kbd[^>]*>⌘↵<\/kbd><\/button>/u);
    // Confirming anyway is its own click, with no key.
    expect(html).toMatch(/data-notes-anyway[^>]*>Confirm anyway<\/button>/u);
    expect(text(html)).toContain("Ask goes to “Spine labels” · listed first, then sent after 8 s with Undo");
    expect(html).not.toContain("data-notes-confirm");
  });

  // The rest of a stack that mentions the PR is shown as evidence worth reading, but it's no reply: asking still leads.
  it("lists the PRs that mention this one under the evidence, and still leads with Ask when nothing else shows the note handled", () => {
    const html = body(read({ linked: [{ repo: "inkwell/folio", number: 302 }, { repo: "inkwell/catalog", number: 97 }] }));
    expect(html).toMatch(/data-notes-evidence[^>]*>No commits, reply, or resolved threads since this approval<\/p><p data-notes-linked[^>]*>Linked: folio #302, catalog #97 mention this PR<\/p>/u);
    expect(html).toMatch(/data-notes-ask[^>]*>Ask its thread to address it<kbd/u);
    expect(html).toMatch(/data-notes-anyway[^>]*>Confirm anyway<\/button>/u);
    expect(body(read())).not.toContain("data-notes-linked");
  });

  it("says why when there's nowhere to ask, and leaves only Confirm anyway's own click and Cancel", () => {
    const html = body(read({}, { kind: "none", why: "This PR has no thread, and nothing to start one under yet." }));
    expect(text(html)).toContain("This PR has no thread, and nothing to start one under yet.");
    expect(html).toMatch(/data-notes-anyway[^>]*>Confirm anyway<\/button>/u);
    expect(html).not.toMatch(/data-notes-(ask|confirm)|⌘↵/u);
  });

  it("leads with Confirm handled when something since the approval shows the note handled", () => {
    const html = body(read({ commits: 2 }));
    expect(text(html)).toContain("2 commits since this approval");
    expect(html).toMatch(/data-notes-confirm[^>]*>Confirm handled<kbd[^>]*>⌘↵<\/kbd><\/button>/u);
    expect(html).not.toContain("data-notes-anyway");
    expect(html).not.toContain("data-notes-ask");
  });

  it("says it's reading, or why GitHub couldn't be read, and offers nothing to confirm meanwhile", () => {
    expect(text(body(null))).toContain("Reading GitHub…");
    const failed = body(null, "HTTP 502");
    expect(text(failed)).toContain("Couldn't read the notes: HTTP 502");
    expect(failed).not.toMatch(/data-notes-(confirm|anyway|ask)/u);
  });
});
