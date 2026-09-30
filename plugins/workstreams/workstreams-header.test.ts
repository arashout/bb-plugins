// One header on every Workstreams view: Efforts · All PRs · More ▾, where the other views and How it works live, and the same right side
// everywhere: freshness, Mark seen where the view has it, ⌘K, and ?. A view that draws its own tabs, or a More that lists fewer views on one
// page, is a second way around the panel that drifts from the first, which is how Work once offered "Inventory" after All PRs replaced it.
import { readdirSync, readFileSync } from "node:fs";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { describe, expect, it } from "vitest";
import { inkwellDeck, inkwellInventory, INKWELL_SHELVING_ROSTER as ROSTER, INVENTORY_NOW as NOW, SHELVING_ROSTER_NOW } from "./inkwell-fixtures.js";
import { availability, cardScreen, hintKeys, stripChips, type KeyContext } from "./deck-view-model.js";
import { DeckPane, MoreItems, viewPaletteItems, WorkstreamsHeader, type DeckCommand, type DeckPaneProps, type HeaderProps } from "./deck-screen.js";
import { inventoryScreen } from "./inventory-view-model.js";
import { InventoryPane, InventoryPending } from "./inventory-screen.js";
import { askCards, firstAsk, rosterView, settle } from "./roster-view-model.js";
import { RosterPane } from "./roster-view.js";

const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/&#x27;/gu, "'").replace(/\s+/gu, " ").trim();
const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
const VIEWS: HeaderProps["view"][] = ["deck", "inventory", "map", "pipeline", "work", "board", "efforts", "roster"];
const MORE = ["Map", "Pipeline", "Work", "Board", "Efforts admin", "How it works"];

/** What a view's header offers: which view it says it's on, its tabs and the pressed one, More's label, and the right side in order. */
function items(html: string) {
  const match = /<header data-ws-header="([^"]+)"[^>]*>([\s\S]*?)<\/header>/u.exec(html);
  if (!match) throw new Error("No shared header");
  const header = match[2]!;
  return {
    view: match[1],
    tabs: [...header.matchAll(/data-deck-focus="view-(?:deck|prs)" aria-pressed="(true|false)"[^>]*>([^<]+)</gu)].map((tab) => `${tab[2]}${tab[1] === "true" ? " ✓" : ""}`),
    more: /data-ws-more[^>]*>([^<]+)</u.exec(header)?.[1],
    freshness: text(/<span role="(?:status|alert)"[^>]*>([\s\S]*?)<\/span><\/span>/u.exec(header)?.[1] ?? ""),
    right: [...header.matchAll(/data-deck-focus="(seen|palette|help)"/gu)].map((control) => control[1]),
  };
}
const header = (view: HeaderProps["view"], patch: Partial<HeaderProps> = {}) => renderToStaticMarkup(createElement(WorkstreamsHeader, {
  view, read: { text: "Read 1m ago", error: null }, palette: "go to", help: "How this works", onView: noop, onPalette: noop, onHelp: noop, ...patch }));
const more = (view: HeaderProps["view"]) => renderToStaticMarkup(createElement(PopoverPrimitive.Root, { open: true }, createElement(MoreItems, { view, go: noop })));
/** The components `clicks` draws on its way to the header's buttons. */
const THROUGH = new Set<unknown>([DeckPane, WorkstreamsHeader, MoreItems]);
/**
 * Every tab, More item, and right-side button under `tree`, by its data key, with what a click on it does. Static markup drops handlers, so this
 * walks the elements, inside a render so the components it draws may use hooks.
 */
function clicks(tree: ReactNode) {
  const found = new Map<string, () => void>();
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!isValidElement<Record<string, unknown>>(node)) return;
    const { props } = node;
    const key = props["data-deck-focus"] ?? props["data-ws-more-item"];
    if (typeof key === "string" && typeof props.onClick === "function") found.set(key, props.onClick as () => void);
    walk(THROUGH.has(node.type) ? (node.type as (props: unknown) => ReactNode)(props) : props.children as ReactNode);
  };
  renderToStaticMarkup(createElement(() => { walk(tree); return null; }));
  return found;
}
const TARGETS = ["view-deck", "view-prs", "map", "pipeline", "work", "board", "efforts", "how"];
/** The deck on Inkwell's Shelf order card, as its nav view draws it; `run` gets every click. */
function deckPane(run: DeckPaneProps["run"] = noop): DeckPaneProps {
  const deck = inkwellDeck();
  const cards = new Map(deck.active.map((item) => [item.id, cardScreen(item, { rows: {}, at: {} }, { now: NOW })]));
  const card = cards.get("effort-shelf-order") ?? null;
  const context: KeyContext = { view: "deck", cur: card, service: null, focused: null, selected: [], seenAvailable: true, undo: false, held: 0, done: 0 };
  const on = availability(context);
  return { chips: stripChips(deck.active.map((item) => item.id), cards, "effort-shelf-order"), cur: "effort-shelf-order",
    card, rules: [], held: [], done: [], read: { text: "Read 25s ago", error: null }, seen: { changed: 1, available: true, note: null },
    state: { selected: new Set<string>(), expanded: new Set<string>(), focus: null }, tiles: new Set<string>(), open: new Set<string>(), pile: null, stuck: false,
    on, hints: hintKeys(context, on), flash: null, batch: { kinds: [] }, run, onPalette: noop, onHelp: noop, onUndo: noop };
}

describe("the shared Workstreams header", () => {
  it("draws the same two tabs, More, freshness, ⌘K, and ? on every view, pressing only the tab you're on", () => {
    for (const view of VIEWS) {
      const got = items(header(view));
      expect(got.tabs).toEqual([view === "deck" ? "Efforts ✓" : "Efforts", view === "inventory" ? "All PRs ✓" : "All PRs"]);
      expect(got.freshness).toBe("Read 1m ago");
      expect(got.right).toEqual(["palette", "help"]);
    }
    // More names the view it holds, so the Map, which has no title of its own, still says where you are.
    expect(VIEWS.map((view) => items(header(view)).more)).toEqual(["More ▾", "More ▾", "Map ▾", "Pipeline ▾", "Work ▾", "Board ▾", "Efforts admin ▾", "More ▾"]);
  });

  it("lists the same views in More on every view, marking only the one you're on, then How it works", () => {
    for (const view of VIEWS) {
      const html = more(view);
      expect([...html.matchAll(/data-ws-more-item="[^"]+"[^>]*>([^<]+)</gu)].map((item) => item[1])).toEqual(MORE);
      expect([...html.matchAll(/data-ws-more-item="([^"]+)" aria-current="page"/gu)].map((item) => item[1])).toEqual(
        ["map", "pipeline", "work", "board", "efforts"].includes(view) ? [view] : []);
    }
  });

  it("shows Mark seen only where the view has it, with that view's key, and a read error in place of freshness", () => {
    expect(items(header("roster", { seen: { changed: 2, available: true, note: null, key: "space" } })).right).toEqual(["seen", "palette", "help"]);
    expect(header("roster", { seen: { changed: 2, available: true, note: null, key: "space" } })).toMatch(/<b>2<\/b> changed here · Mark seen <kbd[^>]*>space<\/kbd>/u);
    expect(header("roster", { seen: { changed: 0, available: true, note: null, key: "space", title: "Settle rows into their groups" } }))
      .toContain('title="Settle rows into their groups"');
    expect(items(header("deck", { seen: { changed: 0, available: false, note: null, key: "s" } })).right).toEqual(["palette", "help"]);
    const failed = header("deck", { read: { text: "Read 1m ago", error: "Couldn't read the deck: HTTP 500" } });
    expect(failed).toMatch(/<span role="alert"[^>]*text-destructive/u);
    expect(items(failed).freshness).toBe("Couldn't read the deck: HTTP 500");
  });

  it("says what ⌘K and ? open on the view: the deck's actions and keys, or the views and How this works", () => {
    expect(header("deck", { palette: "all actions", help: "Keys and colors" })).toMatch(/title="Every action and its key \(⌘K\)"[\s\S]*aria-label="Keys and colors \(\?\)"/u);
    expect(header("map")).toMatch(/title="Go to a view \(⌘K\)"[\s\S]*aria-label="How this works \(\?\)"/u);
    // Where ⌘K has no actions, it goes to every other view or How it works.
    const palette = viewPaletteItems("map");
    expect(palette.map((item) => `${item.title}${item.on ? "" : ` · ${item.why}`}`)).toEqual(
      ["Efforts", "All PRs", "Map · you're here", "Pipeline", "Work", "Board", "Efforts admin", "How it works"]);
  });

  it("sends each tab and More item to its own view and How it works to How this works; a click on the view you're on goes nowhere", () => {
    const sent = (view: HeaderProps["view"]) => {
      const got: string[] = [];
      const on = clicks(createElement(WorkstreamsHeader, { view, read: { text: "", error: null }, palette: "go to", help: "", onView: (target) => got.push(target), onPalette: noop, onHelp: noop }));
      for (const key of TARGETS) on.get(key)!();
      return got;
    };
    expect(sent("roster")).toEqual(["deck", "inventory", "map", "pipeline", "work", "board", "efforts", "how"]);
    expect(sent("map")).toEqual(["deck", "inventory", "pipeline", "work", "board", "efforts", "how"]);
    expect(sent("inventory")).toEqual(["deck", "map", "pipeline", "work", "board", "efforts", "how"]);
  });

  // The Map and Board keep their Approved filter, Rescan, and scan notices only through this slot.
  it("draws a view's own tools after More and before freshness", () => {
    const html = header("map", { tools: createElement("button", { type: "button", "data-tool": "" }, "Approved 3") });
    expect(html).toMatch(/data-ws-more[\s\S]*<button type="button" data-tool="">Approved 3<\/button>[\s\S]*role="status"/u);
  });

  // A narrow panel, or How this works open beside it, must not cut off ⌘K and ? or hide freshness, as a one-row header did on the Map and Board.
  it("wraps on a narrow panel, moving freshness, Mark seen, ⌘K, and ? to their own line as one group on the right", () => {
    const html = header("map", { tools: createElement("button", { type: "button" }, "Approved 3") });
    expect(html).toMatch(/<header [^>]*class="[^"]*\bflex-wrap\b/u);
    expect(html).toMatch(/<div class="ml-auto flex min-w-0[^"]*"><span role="status"[\s\S]*data-deck-focus="help"[^>]*>\?<\/button><\/div><\/header>/u);
  });
});

describe("every Workstreams view", () => {
  it("draws the shared header on the deck, All PRs, and the full-width roster", () => {
    const deckHtml = renderToStaticMarkup(createElement(DeckPane, deckPane()));
    const callbacks = { busyKey: null, error: null, onView: noop, onPalette: noop, onHelp: noop, onOpenPr: noop, onOpenThread: noop, onOpenRoster: noop, onNudge: noop, onAsk: noop };
    const inventory = renderToStaticMarkup(createElement(InventoryPane, { screen: inventoryScreen(inkwellInventory(), { now: NOW, filter: null }), ...callbacks }));
    const pending = renderToStaticMarkup(createElement(InventoryPending, { error: null, onRetry: noop, onView: noop, onPalette: noop, onHelp: noop }));
    const view = rosterView(ROSTER, { order: "number", now: SHELVING_ROSTER_NOW, settled: settle(ROSTER), seen: { seq: 400, at: SHELVING_ROSTER_NOW - 60 * 60_000 } });
    const roster = renderToStaticMarkup(createElement(RosterPane, { view, wide: true, mount: "nav", live: true, order: "number", focusN: null, menuN: null, liveThreads: new Set<string>(),
      command: { value: "", onValue: noop, onSubmit: noop, ack: null, open: false, onToggle: noop, onLeave: noop, note: null },
      asks: { ...askCards(ROSTER), state: { focus: firstAsk(askCards(ROSTER).asks), open: null, picks: new Map(), subsets: new Map(), hint: null }, wide: true, now: SHELVING_ROSTER_NOW,
        onFocusAsk: noop, onFocus: noop, onAnswer: noop, onField: noop, onSubset: noop, onCompose: noop, onUndo: noop, onRecover: noop, onPreview: noop, onOpenThread: noop, onOpenUrl: noop },
      history: ROSTER.history, hasParent: true, onOrder: noop, onMarkSeen: noop, onHeader: noop, onFocus: noop, onCompose: noop, onMenu: noop, onAction: noop, onToggleGroup: noop,
      onOpenUrl: noop, header: createElement(WorkstreamsHeader, { view: "roster", read: { text: "Scanned 2m ago · GitHub 1m ago", error: null }, palette: "go to", help: "Roster keys",
        seen: { changed: 0, available: true, note: null, key: "space" }, onView: noop, onPalette: noop, onHelp: noop }) }));
    const got = [deckHtml, inventory, pending, roster].map(items);
    expect(got.map((item) => item.view)).toEqual(["deck", "inventory", "inventory", "roster"]);
    expect(got.map((item) => item.tabs)).toEqual([["Efforts ✓", "All PRs"], ["Efforts", "All PRs ✓"], ["Efforts", "All PRs ✓"], ["Efforts", "All PRs"]]);
    expect(got.map((item) => item.more)).toEqual(["More ▾", "More ▾", "More ▾", "More ▾"]);
    expect(got.map((item) => item.right)).toEqual([["seen", "palette", "help"], ["palette", "help"], ["palette", "help"], ["seen", "palette", "help"]]);
    expect(got.map((item) => item.freshness)).toEqual(["Read 25s ago", "Last read 25s ago", "Reading…", "Scanned 2m ago · GitHub 1m ago"]);
    // The full-width roster keeps one Mark seen, in the header: its since-line drops its own.
    expect(roster.match(/data-deck-focus="seen"/gu)).toHaveLength(1);
    expect(roster).not.toContain(">Mark seen</button>");
  });

  // The deck's header clicks go through its nav view's run, so a click there has to reach the page's go as the view it names.
  it("sends the deck's header clicks to the page as the view each names, and Mark seen to the deck's own action", () => {
    const commands: DeckCommand[] = [];
    const click = clicks(createElement(DeckPane, deckPane((command) => commands.push(command))));
    for (const key of [...TARGETS, "seen"]) click.get(key)!();
    expect(commands).toEqual([...["inventory", "map", "pipeline", "work", "board", "efforts", "how"].map((view) => ({ kind: "view", view })), { kind: "action", id: "seen" }]);
    // The nav view hands a view command on as it came, and the page opens How this works for how and the view's path for the rest.
    expect(source("deck-nav-view.tsx")).toContain('case "view": onView(command.view); return;');
    const app = source("app.tsx");
    expect(app).toMatch(/const go = useCallback\(\(target: HeaderTarget\) => \{\n\s+if \(target === "how"\) openHow\(\);\n\s+else navigate\.toPluginPanel\("board", \{ subPath: target \}\);/u);
    expect(app.match(/onView=\{go\}|onView: go/gu)).toHaveLength(4);
  });

  // The Map, Pipeline, Work, legacy Board, Efforts admin, and roster pages call the SDK, so their wiring is checked in the source.
  it("wires the header into the Map, Pipeline, Work, Board, Efforts admin, and roster pages, and no view draws tabs of its own", () => {
    const app = source("app.tsx");
    for (const view of ["map", "pipeline", "work", "board", "efforts"]) expect(app).toContain(`{header("${view}"`);
    // The Map and the Board pass their Approved filter, Rescan, and scan notices as the header's tools.
    expect([...app.matchAll(/\{header\("(\w+)", boardTools\)\}/gu)].map((match) => match[1]).sort()).toEqual(["board", "map"]);
    expect(app).toMatch(/const boardTools = <>[\s\S]*>Approved \{approvedCount\}<[\s\S]*rpc\.call\("board_refresh"\)[\s\S]*<Warnings warnings=\{board\.warnings\} \/>\}\n\s+<\/>;/u);
    const roster = source("roster-view.tsx");
    expect(roster.match(/<WorkstreamsHeader view="roster"/gu)).toHaveLength(2);
    expect(roster).toMatch(/<RosterView key=\{route\.effortId\} [^>]*chrome=\{chrome\}/u);
    expect(source("deck-screen.tsx")).toContain('<WorkstreamsHeader view="deck"');
    expect(source("inventory-screen.tsx")).toContain('<WorkstreamsHeader view="inventory"');
    const views = readdirSync(new URL(".", import.meta.url)).filter((file) => file.endsWith(".tsx"));
    expect(views.filter((file) => /aria-label="Workstreams views"/u.test(source(file)))).toEqual(["deck-screen.tsx"]);
  });
});
