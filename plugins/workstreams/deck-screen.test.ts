import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConfirmRead } from "./approval-evidence.js";
import type { DeckView } from "./deck.js";
import { inkwellDeck, inkwellInventory, inkwellSuggestions, inkwellThreads, INVENTORY_EFFORTS, INVENTORY_NOW as NOW } from "./inkwell-fixtures.js";
import { availability, cardScreen, hintKeys, overviewScreen, paletteItems, priorityOf, stripChips, type Accepted, type CardScreen, type KeyContext }
  from "./deck-view-model.js";
import { ConfirmBody, DeckPane, HelpBody, HintBar, NotesBody, PaletteBody, RuleBody, SeedBody, WeakBody, type ConfirmPlan, type DeckPaneProps } from "./deck-screen.js";
import { notesScreen } from "./deck-view-model.js";
import { inventoryScreen } from "./inventory-view-model.js";
import type { LinearDetail } from "./linear.js";
import type { SeedProposal } from "./linear-seed.js";

const SHELF = INVENTORY_EFFORTS.shelf.id, PICKUP = INVENTORY_EFFORTS.pickup.id, ONE_OFFS = "effort-one-offs", FOLIO = "service:inkwell/folio", CATALOG = "service:inkwell/catalog";
const DAY = 86_400_000;
const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
const noop = () => {};
const none = { rows: {} };
const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/&quot;/gu, '"').replace(/&#x27;/gu, "'").replace(/&amp;/gu, "&").replace(/\s+/gu, " ");
/** All PRs' rows for the fixture's PRs, which each move draws. */
const LINES = new Map(inventoryScreen(inkwellInventory(), { now: NOW, filter: null }).groups.flatMap((group) => group.lines.map((line) => [line.prUrl, line] as const)));

function pane(view: DeckView, cur: string, patch: Partial<DeckPaneProps> = {}, accepted: Accepted = new Map()) {
  const cards = new Map(view.active.map((item) => [item.id, cardScreen(item, none, { now: NOW, accepted })]));
  const card = patch.card === undefined ? cards.get(cur) ?? null : patch.card;
  // The Address move's rows start ticked, as the deck draws them.
  const picked = patch.kit?.picked ?? new Set(card?.moves.find((move) => move.kind === "address")?.prUrls ?? []);
  const context: KeyContext = { view: "deck", cur: card ?? (cur === "overview" ? "overview" : null), service: FOLIO, focused: null,
    selected: card?.lines.filter((line) => picked.has(line.prUrl)) ?? [], seenAvailable: false, undo: false, held: 1, done: 1 };
  const on = availability(context);
  return renderToStaticMarkup(createElement(DeckPane, {
    chips: stripChips(view.active.map((item) => item.id), cards, cur), cur, card,
    overview: cur === "overview" ? overviewScreen(view.active.map((item) => item.id), cards) : null,
    rules: [{ id: "r1", text: "Branch shelf/* → Shelf order · 2 this week" }], held: [{ id: "effort-gift-cards", key: "effort-gift-cards", name: "Gift cards", note: "Waiting on the card vendor" }],
    done: [{ id: "effort-store-hours", key: "effort-store-hours", name: "Store hours", note: "0 merged" }], read: { text: "Read 25s ago", error: null },
    seen: { changed: 0, available: false, note: null }, open: new Set<string>(), panel: null, pile: null,
    on, hints: hintKeys(context, on), flash: null, run: noop, onPalette: noop, onHelp: noop, onUndo: noop, ...patch, kit: { lines: LINES, picked, ...patch.kit } }));
}
/** A button's text and whether it's disabled, by its data-deck-focus id. */
const button = (html: string, focus: string) => {
  const match = new RegExp(`<button[^>]*data-deck-focus="${focus}"([^>]*)>(.*?)</button>`, "u").exec(html)!;
  return { text: text(match[2]!).trim(), disabled: /aria-disabled="true"/u.test(match[0]!) };
};
/** The markup from one data attribute's element to the next one's. */
const part = (html: string, attr: string, key: string) => {
  const start = html.indexOf(`${attr}="${key}"`);
  const end = html.indexOf(`${attr}=`, start + attr.length + 2);
  return html.slice(start, end === -1 ? undefined : end);
};
const section = (html: string, key: string) => part(html, "data-deck-sec", key);
const move = (html: string, kind: string) => part(html, "data-deck-move", kind);
/** The rows drawn in some markup, by All PRs' name for each. */
const rows = (html: string) => [...html.matchAll(/data-inventory-row="([^"]+)"/gu)].map((match) => match[1]);
/** Shelf order with its tickets in Linear, its project's target, and four merges in the last two weeks, so its finish line has every part. */
const shelfLinear = () => {
  const ticket = (n: number, state: string, type: string): [string, LinearDetail] => [`ABC-${n}`, { identifier: `ABC-${n}`, title: null, description: null,
    state: { name: state, type }, project: { id: "p1", name: "Shelf redesign", targetDate: "2026-10-14" }, parent: null, labels: [], url: null, updatedAt: null,
    cycle: { number: 41, name: null, endsAt: "2026-10-07T00:00:00.000Z" }, assignee: null, source: "key" }];
  return inkwellDeck({ linear: new Map([ticket(360, "In Review", "started"), ticket(361, "Done", "completed"), ticket(362, "In Review", "started"),
    ticket(363, "Todo", "unstarted"), ticket(364, "Done", "completed")]),
  merges: [1, 4, 7, 10].map((daysAgo, index) => ({ url: url("folio", 290 + index), at: NOW - daysAgo * DAY, effortId: SHELF })) },
  (row) => row.number === 343 ? { hold: { reason: "Wait for the store launch", heldAt: NOW - DAY } } : {});
};

describe("the effort deck's markup", () => {
  it("draws the strip in session order with each card's number, color dot, and Your turn, the service cards last and dashed, and both piles", () => {
    const html = pane(inkwellDeck(), SHELF);
    const chips = [...html.matchAll(/data-deck-chip="([^"]+)"[^>]*>(.*?)<\/button>/gu)].map((match) => text(match[2]!).trim());
    expect(chips).toEqual(["Overview", "1 Shelf order 0", "2 Store pickup 3", "3 One-offs 2", "4 folio · service 0", "5 atlas · service 0", "6 catalog · service 0"]);
    expect(html).toMatch(/data-deck-chip="service:inkwell\/folio" title="folio · service: 0 your turn \(4\)" class="[^"]*border-dashed/u);
    // Only a chip where a person waits on you turns amber.
    expect(html).toMatch(/data-deck-chip="effort-store-pickup"[^>]*>.*?<span class="[^"]*bg-amber-500\/10[^"]*">3<\/span>/u);
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
    expect(text(html)).toContain("Store pickup 3 your turn · 2 blocked · 0 in flight");
    expect(html.match(/data-deck-focus="overview-effort-/gu)).toHaveLength(3);
    expect(html).not.toContain("data-deck-card");
    expect(html).not.toContain('data-deck-focus="seen"');
  });

  it("uses one PR-count scale across Action matrix efforts and names the scale and colors", () => {
    const view = inkwellDeck();
    const cards = view.active.slice(0, 2).map((item, index) => ({ ...cardScreen(item, none, { now: NOW }), yourTurn: 0, blocked: [],
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
    // Service cards alone are no efforts: Overview stays empty and draws none of their rows or suggestions.
    const services = pane({ ...inkwellDeck(), active: inkwellDeck().active.filter((item) => item.kind !== "effort") }, "overview");
    expect(text(services)).toContain("No active efforts yet.");
    expect(services).not.toContain("data-deck-suggest");
    expect(services).not.toContain("data-inventory-row=");
  });

  it("keeps the loading message until the first deck read supplies Overview", () => {
    const html = pane({ ...inkwellDeck(), active: [] }, "overview", { overview: null });
    expect(text(html)).toContain("Reading your efforts…");
    expect(html).not.toContain("No active efforts yet.");
  });

  // The card answers what to do next before anything else: how far along it is, then its few moves, each over the rows it touches.
  it("opens an effort's card on its finish line, then up to three moves, each an outcome, one verb, and its key, the first leading", () => {
    const html = pane(shelfLinear(), SHELF);
    expect(text(part(html, "data-deck-finish", "true"))).toContain("2 of 5 done · Target Oct 14 · 14d left · ETA Oct 18 at 2/wk");
    expect(html).toMatch(/<span class="text-amber-700 dark:text-amber-300">ETA Oct 18 at 2\/wk<\/span>/u);
    // ABC-361 and ABC-364 are Done in Linear while folio #341 and #330 are open, so Reconcile ranks after them.
    expect([...html.matchAll(/data-deck-move="(\w+)"/gu)].map((match) => match[1])).toEqual(["merge", "fix", "reconcile"]);
    expect(text(move(html, "merge"))).toContain("3 ready to merge Ready to merge 1 · stacked 2 Merge 3… m");
    expect(move(html, "merge")).toMatch(/data-deck-focus="act-merge"[^>]*class="[^"]*border-foreground bg-foreground/u);
    expect(button(html, "act-fix")).toEqual({ text: "Fix 1… f", disabled: false });
    // The first move shows its rows, All PRs' own two-line rows; the others fold until you open them.
    expect([rows(move(html, "merge")), rows(move(html, "fix"))]).toEqual([["inkwell/folio#340", "inkwell/folio#341", "inkwell/folio#342"], []]);
    expect(move(html, "merge")).toContain("Ready to merge · Merge · 2d");
    const flipped = pane(shelfLinear(), SHELF, { open: new Set(["merge", "fix"]) });
    expect([rows(move(flipped, "merge")), rows(move(flipped, "fix"))]).toEqual([[], ["inkwell/folio#330"]]);
    // A repository name truncates before a PR's number does.
    for (const repo of [...html.matchAll(/<span class="min-w-0 truncate">([^<]*)<\/span>/gu)].map((match) => match[1]!)) expect(repo).not.toMatch(/#\d/u);
  });

  // effort-card-v2 removed what read as noise on live data: tiles that were empty or repeated the rows, sections with a button each,
  // counts that mixed chores in with people waiting on you, four of Advance's five entry points, and rows that waited for Mark seen.
  it("draws no tiles, sections, need-you counts, row Advance, or settling rows, and Advance only on its line", () => {
    for (const id of [SHELF, PICKUP, ONE_OFFS, FOLIO]) {
      const html = pane(inkwellDeck(), id);
      expect(html).not.toMatch(/data-deck-(tile|row|counts|inline|to|arrive|filter)=/u);
      // Only a service card's suggestions still group rows, under the card.
      const groups = html.indexOf("data-deck-sec=");
      expect(id === FOLIO ? groups > html.indexOf("data-deck-suggest") : groups === -1).toBe(true);
      expect(text(html)).not.toMatch(/need you|Next steps|People|Recent|Stats|lands here|moved to|Ask threads to fix/u);
      expect(html).not.toContain('aria-label="Selection"');
      expect((html.match(/data-deck-focus="act-advance"/gu) ?? []).length).toBe(id === ONE_OFFS || id === FOLIO ? 1 : 0);
    }
  });

  // Matt approved Address alone starting at once, with 8 s to Undo; its rows start ticked, as its listing, and you untick any to leave out.
  it("leads with Address when someone waits on you: who, how long, and its rows ticked, which it starts at once", () => {
    const html = pane(inkwellDeck(), PICKUP);
    expect(text(html)).toContain("Store pickup 3 your turn Store pickup for every reader.");
    expect(text(move(html, "address"))).toContain("@otto-v, @ines-v wait on you 3 PRs · 1d Address 3 b");
    expect(move(html, "address")).toMatch(/data-deck-focus="act-address" title="Starts one thread for the ticked PRs now, with 8 s to Undo\. Nothing merges\. \(b\)"/u);
    expect(move(html, "address").match(/type="checkbox"[^>]*checked=""/gu)).toHaveLength(3);
    expect(text(move(html, "address"))).toContain("Changes requested by @otto-v · 1d");
    const two = pane(inkwellDeck(), PICKUP, { kit: { lines: LINES, picked: new Set([url("quill", 210), url("quill", 211)]) } });
    expect(button(two, "act-address")).toEqual({ text: "Address 2 b", disabled: false });
    const nothing = pane(inkwellDeck(), PICKUP, { kit: { lines: LINES, picked: new Set() } });
    expect(button(nothing, "act-address")).toEqual({ text: "Address 0 b", disabled: true });
    expect(nothing).toMatch(/title="Address: no Your turn row is ticked"/u);
    // Why the last Address started nothing stays under it, in the server's words.
    const refused = pane(inkwellDeck(), PICKUP, { kit: { lines: LINES, picked: new Set([url("quill", 210)]), refusal: "Nothing started. quill #210: On hold. Release it first." } });
    expect(move(refused, "address")).toMatch(/role="alert" data-deck-refusal="true"[^>]*>Nothing started\. quill #210: On hold\. Release it first\.</u);
  });

  it("folds chores into one Advance line that never turns amber, its rows folded until you open them", () => {
    const html = pane(inkwellDeck(), ONE_OFFS);
    const line = part(html, "data-deck-advance", "true");
    expect(text(line)).toContain("Chores nudge 1 Advance 1 a");
    expect(line).not.toMatch(/amber/u);
    expect(rows(line)).toEqual([]);
    // Opened, a chore's row keeps All PRs' Nudge button, which opens the deck's listing confirm.
    const open = part(pane(inkwellDeck(), ONE_OFFS, { open: new Set(["chores"]) }), "data-deck-advance", "true");
    expect([rows(open), /data-inventory-action="nudge"/u.test(open)]).toEqual([["inkwell/catalog#96"], true]);
  });

  it("keeps Notes, Threads, Linear, Held, and All PRs as toggles, closed until you open one, each a panel of its own", () => {
    const view = shelfLinear();
    const html = pane(view, SHELF);
    expect([...html.matchAll(/data-deck-focus="panel-(\w+)" aria-pressed="false"[^>]*>(.*?)<\/button>/gu)].map((match) => text(match[2]!).trim()))
      .toEqual(["Notes", "Threads 1", "Linear 5", "Held 1", "All 5 PRs"]);
    expect(html).not.toContain("data-deck-panel");
    const all = pane(view, SHELF, { panel: "all" });
    expect(rows(part(all, "data-deck-panel", "all"))).toEqual(["inkwell/folio#340", "inkwell/folio#341", "inkwell/folio#342", "inkwell/folio#330", "inkwell/folio#343"]);
    expect(all).toMatch(/data-deck-focus="panel-all" aria-pressed="true"/u);
    const held = part(pane(view, SHELF, { panel: "held" }), "data-deck-panel", "held");
    expect([text(held).includes("Release 1… l"), rows(held)]).toEqual([true, ["inkwell/folio#343"]]);
    expect(text(part(pane(view, SHELF, { panel: "linear" }), "data-deck-panel", "linear"))).toContain("▣ Shelf redesign");
    // Notes render with the Markdown they're given, and edit in place.
    const noted = { ...view, active: view.active.map((item) => item.id === SHELF ? { ...item, notes: { body: "## Flags\n- shelf_v2", revision: 2, updatedAt: NOW } } : item) };
    const notes = pane(noted, SHELF, { panel: "notes", markdown: (body) => createElement("div", { "data-md": "true" }, body) });
    expect(notes).toMatch(/data-deck-notes-body="true"[^>]*><div data-md="true">## Flags\n- shelf_v2<\/div>/u);
    expect(button(notes, "notes-edit")).toEqual({ text: "Edit ⇧N", disabled: false });
    const editing = pane(noted, SHELF, { panel: "notes", notes: { draft: "## Flags", busy: false, error: null } });
    expect(editing).toContain("data-deck-notes-editor");
    expect(text(editing)).toContain("Cancel esc Save ⌘↵");
  });

  it("opens the finish line, with p, to say whether it's on track, what's left, who holds it, whether it's moving, and what stands before Done", () => {
    const html = pane(shelfLinear(), SHELF, { open: new Set(["progress"]) });
    expect(html).toMatch(/data-deck-focus="progress" aria-expanded="true"/u);
    expect([...part(html, "data-deck-answers", "true").matchAll(/<dt[^>]*>([^<]+)<\/dt>/gu)].map((match) => match[1]))
      .toEqual(["On track?", "What&#x27;s left", "Who holds it", "Moving?", "To Done"]);
    expect(text(part(html, "data-deck-answers", "true"))).toContain("Behind: ETA Oct 18, 4d after the target");
    // One-offs merge on their own, so they draw no finish line.
    expect(pane(inkwellDeck(), ONE_OFFS)).not.toContain("data-deck-finish");
  });

  // Reconcile writes nothing: Show unfolds the open PRs of tickets Linear calls done, and the other line opens Linear to move a ticket.
  it("draws Reconcile as a line per mismatch with its tickets and one button, Show unfolding its open PRs, and Open in Linear", () => {
    const view = shelfLinear();
    const merged = { ...view, active: view.active.map((item) => item.id === SHELF ? { ...item, linear: { ...item.linear,
      reconcile: { ...item.linear.reconcile, merged: [{ id: "ABC-365", url: "https://linear.app/inkwell/issue/ABC-365" }] } } } : item) };
    const html = move(pane(merged, SHELF), "reconcile");
    expect([...html.matchAll(/data-deck-mismatch="\w+"[^>]*>(.*?)<\/button><\/div>/gu)].map((match) => text(match[1]!).trim()))
      .toEqual(["2 Done in Linear · 2 PRs open ABC-361, ABC-364 Show 2", "1 open with every PR merged ABC-365 Open in Linear ↗"]);
    expect(html).toMatch(/title="Open ABC-365 in Linear"/u);
    // Its rows fold until you show them, even as the card's only move; they're never ticked for Address.
    expect(rows(html)).toEqual([]);
    const shown = move(pane(merged, SHELF, { open: new Set(["reconcile"]) }), "reconcile");
    expect([rows(shown), /type="checkbox"/u.test(shown), /aria-expanded="true"[^>]*>Show 2/u.test(shown)]).toEqual([["inkwell/folio#341", "inkwell/folio#330"], false, true]);
  });

  it("puts each row's ticket on a chip, with its Linear priority as a glyph", () => {
    const view = shelfLinear();
    const high = { ...view, active: view.active.map((item) => item.id === SHELF ? { ...item, linear: { ...item.linear,
      issues: item.linear.issues.map((issue) => issue.id === "ABC-360" ? { ...issue, priority: 2, label: "High" } : issue) } } : item) };
    const merge = move(pane(high, SHELF), "merge");
    // The glyph's bars are set apart by hair spaces, which text() would fold, so only the tags come out here.
    expect([...merge.matchAll(/data-inventory-ticket="[^"]*"[^>]*title="([^"]*)"[^>]*>(.*?)<\/span><\/span>/gu)]
      .map((match) => [match[1], match[2]!.replace(/<[^>]+>/gu, " ").replace(/ +/gu, " ").trim()]))
      .toEqual([["ABC-360 · High priority", `${priorityOf({ priority: 2, label: null })!.glyph} ABC-360`], ["ABC-361", "ABC-361"], ["ABC-362", "ABC-362"]]);
  });

  it("gives an effort Hold and Complete, One-offs neither, and a held effort Resume with nothing to move", () => {
    expect([button(pane(inkwellDeck(), SHELF), "act-hold"), button(pane(inkwellDeck(), SHELF), "act-complete")]).toEqual([{ text: "Hold h", disabled: false },
      { text: "Complete", disabled: false }]);
    expect(pane(inkwellDeck(), ONE_OFFS)).not.toMatch(/act-(hold|complete)/u);
    const view = inkwellDeck();
    const held = cardScreen({ ...view.active.find((item) => item.id === SHELF)!, pile: "held", reason: "Waiting on the design review" }, none, { now: NOW });
    const html = pane(view, SHELF, { card: held });
    expect(text(html)).toContain("Resume");
    expect(text(html)).toContain("held: Waiting on the design review");
    expect(text(html)).toContain("On hold: nothing here acts until you resume it.");
    expect(html).not.toContain("data-deck-move");
    // Nothing to move on a live card says so: Store pickup's Your turn rows dismissed, its rest stacked.
    const quiet = pane(inkwellDeck({}, (row) => [210, 211, 155].includes(row.number) ? { dismissed: true } : {}), PICKUP);
    expect(text(quiet)).toContain("Nothing to move.");
  });

  it("stacks the next efforts behind the card, each further right and smaller, with the next one's name up its edge", () => {
    const html = pane(inkwellDeck(), SHELF);
    const layers = [...html.matchAll(/data-deck-layer="(\d)"([^>]*)>/gu)].map((match) => `${match[1]}${/aria-hidden="true"/u.test(match[2]!) ? " hidden" : ""} ${
      /transform:([^;"]+)/u.exec(match[2]!)![1]}`);
    expect(layers).toEqual(["1 translateX(14px) scale(0.98)", "2 hidden translateX(18px) scale(0.96)", "3 hidden translateX(22px) scale(0.94)"]);
    expect(html).toMatch(/<button type="button" tabindex="-1" data-deck-peek="effort-store-pickup" title="Next: Store pickup \(\] or →\)" aria-label="Next effort: Store pickup"/u);
    // The deepest edge's room is a gutter on the stack's right, inside the deck's width, and nothing peeks below.
    expect(html).toMatch(/<div class="mb-2.5" style="padding-right:22px"><div data-deck-stack="true"/u);
    expect(html).not.toMatch(/padding-bottom/u);
    expect(html.indexOf("data-deck-top")).toBeLessThan(html.indexOf('data-deck-card="effort-shelf-order"'));
    // A flip draws the card it takes away in the ghost, which is empty until then and never read aloud, clipped at the top card's bottom edge.
    expect(html).toMatch(/<div data-deck-ghost="true" aria-hidden="true" class="[^"]*\binset-0\b[^"]*" style="clip-path:inset\(-60px -60px 0 -60px\)"><\/div>/u);
    // The last effort's next card is the first service card; the last service card's wraps to Overview, which opens the ring, named without
    // a dot; a pile of two, Overview and one card, has one card behind.
    expect(pane(inkwellDeck(), ONE_OFFS).match(/data-deck-peek="([^"]+)"/u)?.[1]).toBe(FOLIO);
    const last = pane(inkwellDeck(), CATALOG);
    expect(last).toMatch(/data-deck-peek="overview" title="Next: Overview \(\] or →\)"[^>]*><span class="[^"]*\btruncate\b[^"]*">Overview<\/span><\/button>/u);
    const view = inkwellDeck();
    const cards = new Map(view.active.map((item) => [item.id, cardScreen(item, none, { now: NOW })]));
    const two = pane(view, SHELF, { chips: stripChips([SHELF], cards, SHELF) });
    expect(two.match(/data-deck-layer=/gu)).toHaveLength(1);
    expect(two).toMatch(/style="padding-right:14px"/u);
  });

  it("says the card a flip landed on in one polite status line, and nothing until then", () => {
    expect(pane(inkwellDeck(), SHELF)).toMatch(/<p role="status" data-deck-announce="true" class="sr-only"><\/p>/u);
    expect(pane(inkwellDeck(), SHELF, { announce: "Shelf order" })).toMatch(/<p role="status" data-deck-announce="true" class="sr-only">Shelf order<\/p>/u);
  });

  it("draws each pile as a tiny stack of cards, each behind further right as the deck's are, and an empty pile as an outline", () => {
    const html = pane(inkwellDeck(), SHELF, { held: [] });
    const piles = [...html.matchAll(/data-deck-pile="(\w+)"[^>]*><span aria-hidden="true" data-deck-pile-cards="(\w+)"[^>]*>(.*?)<\/span>/gu)]
      .map((match) => `${match[1]} ${match[2]} ${match[3]!.match(/<i /gu)!.length}`);
    expect(piles).toEqual(["hold empty 1", "done stacked 3"]);
    expect([...html.matchAll(/data-deck-pile-cards="stacked".*?<\/span>/gu)][0]![0].match(/transform:[^;"]+/gu))
      .toEqual(["transform:translateX(4px) scale(0.8)", "transform:translateX(2px) scale(0.9)", "transform:translateX(0px) scale(1)"]);
    expect(html).toMatch(/data-deck-pile-cards="empty"[^>]*><i class="[^"]*border-dashed/u);
  });

  it("draws a service card as an effort's with a hollow dot, Promote in place of Hold and Complete, its chores, and its suggestions and rules under it", () => {
    const html = pane(inkwellDeck(), FOLIO);
    expect(html).toMatch(/data-deck-card="service:inkwell\/folio"/u);
    expect(text(html)).toContain("folio · service Work in folio that no effort has yet.");
    expect(button(html, "act-promote")).toEqual({ text: "Promote to effort…", disabled: false });
    expect(html).not.toContain("act-hold");
    expect(html).not.toContain("act-complete");
    expect(text(part(html, "data-deck-advance", "true"))).toContain("Chores request 2 Advance 2 a");
    expect(html.indexOf("data-deck-card")).toBeLessThan(html.indexOf("data-deck-suggest"));
    expect(text(html)).toContain("Suggestions Nothing moves until you press it. Seed from Linear… + Standing rule Branch shelf/* → Shelf order · 2 this week");
    const group = text(section(html, `${FOLIO} effort:${SHELF}:high`));
    expect(group).toContain("→ Shelf order strong ticket ABC-355 · prefix ABC folio #325 Put 1 in Shelf order ⇧A");
    expect(group.match(/ticket ABC-355 · prefix ABC/gu)).toHaveLength(1);
    expect(text(section(html, `${FOLIO} none`))).toContain("No clear signal Pick an effort for each PR. folio #305 Pick per PR e");
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

  it("draws a card with only threads as its header and its threads, with no action to take", () => {
    const view = inkwellDeck(inkwellThreads());
    const loose = pane(view, "loose");
    expect(loose).not.toMatch(/act-advance|data-deck-move|data-deck-toggles/u);
    expect(text(loose)).toContain("Loose threads Threads with no effort or repository yet.");
    expect(text(loose)).toContain("Look at a flaky test");
    const quill = pane(view, "service:inkwell/quill");
    expect(quill).not.toContain("act-promote");
    expect(quill).not.toContain("data-deck-suggest");
    expect(text(quill)).toContain("Try a quieter quill layout");
  });

  it("collapses a group to one line with Undo once you accepted all of it here, and keeps drawing the rest", () => {
    const [shelf, , rest] = inkwellSuggestions();
    const view = inkwellDeck({ classify: { oneOffsId: ONE_OFFS, groups: [{ ...shelf!, prs: [...shelf!.prs, rest!.prs[0]!] }] } });
    const key = `${FOLIO} ${shelf!.key}`;
    const all = pane(view, FOLIO, {}, new Map([[key, { actionId: "a1", text: "2 PRs → Shelf order", prUrls: [url("folio", 325), url("folio", 305)] }]]));
    expect(text(section(all, key))).toContain("✓ 2 PRs → Shelf order Undo");
    expect(all).toContain(`data-deck-focus="undo-group-${key}"`);
    // Only folio #325 moved: #305 is still here, with the group's button.
    const partial = pane(view, FOLIO, {}, new Map([[key, { actionId: "a1", text: "1 PR → Shelf order", prUrls: [url("folio", 325)] }]]));
    expect(button(partial, `group-${key}`)).toEqual({ text: "Put 2 in Shelf order ⇧A", disabled: false });
  });

  it("sizes the card, its rows, and the hint bar by the pane's width, never the window's, so a narrow pane on a wide screen keeps its titles", () => {
    for (const id of [SHELF, PICKUP]) {
      const html = pane(shelfLinear(), id, { open: new Set(["progress"]) });
      expect(html).not.toMatch(/(?:^|[\s"])(?:sm|md|lg|xl):/u);
      expect(html).toMatch(/data-deck-scroller="true" class="@container/u);
      expect(html).toMatch(/data-deck-card="[^"]+" aria-label="[^"]+" class="@container/u);
    }
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

  it("marks a weak group, and lists each PR with its signals before a weak accept moves them", () => {
    const [shelf, ...rest] = inkwellSuggestions();
    const view = inkwellDeck({ classify: { oneOffsId: ONE_OFFS, groups: [{ ...shelf!, key: `effort:${SHELF}:low`, confidence: "low", reason: "Same code area",
      signals: ["area inkwell/folio:shelves"] }, ...rest] } });
    const group = section(pane(view, FOLIO), `${FOLIO} effort:${SHELF}:low`);
    expect(text(group)).toContain("→ Shelf order weak area inkwell/folio:shelves folio #325 Put 1 in Shelf order… ⇧A");
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
    // ? says how moves rank, in the order a card shows them, each with its keys.
    expect(help).toContain("How moves rank Someone waits on you b One step from merged m c Your blockers f A reviewer holds it 4+ days n Linear and GitHub disagree");
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

// Matt: "it takes a while to advance any checked PRs and there's zero UI feedback." From the click until the plan answers, the rows it
// takes pulse; while it sends, each Address row says where it is, and the hint bar counts the items.
describe("a batch while it plans and sends", () => {
  const picked = [url("quill", 210), url("quill", 211)];

  it("marks the rows the plan takes as pending, and only those, until it answers", () => {
    const working = (html: string) => [...html.matchAll(/data-inventory-row="([^"]+)"[^>]*?data-inventory-working="true"/gu)].map((match) => match[1]);
    expect(working(pane(inkwellDeck(), PICKUP))).toEqual([]);
    const pending = pane(inkwellDeck(), PICKUP, { kit: { lines: LINES, picked: new Set(picked), working: new Set(picked) } });
    expect(working(pending)).toEqual(["inkwell/quill#210", "inkwell/quill#211"]);
    expect(pending).toMatch(/data-inventory-working="true" aria-busy="true" class="[^"]*motion-safe:animate-pulse motion-reduce:opacity-60/u);
  });

  it("shows each Address row's item as dispatch moves it, queued, sending, then sent or not, and Sending 3 of 7… in the status line", () => {
    const live = (a: string, b: string) => new Map([[picked[0]!, { kind: "address" as const, state: a as "pending" }], [picked[1]!, { kind: "address" as const, state: b as "pending" }]]);
    const chips = (a: string, b: string) => { const html = move(pane(inkwellDeck(), PICKUP, { kit: { lines: LINES, picked: new Set(picked), live: live(a, b) } }), "address");
      return [[...html.matchAll(/data-inventory-live="(\w+)"/gu)].map((match) => match[1]), text(html)]; };
    const [sending, words] = chips("sending", "pending");
    expect([sending, words.includes("↻ Sending…"), words.includes("Queued")]).toEqual([["sending", "pending"], true, true]);
    expect(chips("sent", "refused")[0]).toEqual(["sent", "refused"]);
    expect(chips("sent", "refused")[1]).toContain("Not sent");
    const status = renderToStaticMarkup(createElement(HintBar, { hints: [], flash: { text: "Sending 3 of 7…", undo: false, busy: true }, onPalette: noop, onHelp: noop, onUndo: noop }));
    expect(status).toMatch(/role="status"[^>]*><span[^>]*><span aria-hidden="true" data-spin="true"[^>]*>↻<\/span><span class="truncate">Sending 3 of 7…<\/span>/u);
    expect(renderToStaticMarkup(createElement(HintBar, { hints: [], flash: { text: "2 sent", undo: false }, onPalette: noop, onHelp: noop, onUndo: noop }))).not.toContain("data-spin");
  });
});
