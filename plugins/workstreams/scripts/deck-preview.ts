// Render the effort deck's Inkwell fixture to static HTML for a visual
// check, since installing this build migrates the live store. It writes only
// $TMPDIR/deck-preview.html, styled by the last `bb plugin build`'s
// dist/app.css over host colors and a minimal Preflight, both of which the
// host supplies. The pane fills the window, so one file serves every
// screenshot size. The hash picks what it draws: a card's id opens on that
// card, else it opens on Overview, as the deck does, and "light" uses light
// host colors (#effort-store-pickup,light), which want the browser's light
// color scheme, since dark: follows it.
// The [ ] ← → keys, the strip's arrow buttons, and the next card's edge
// flip it with the deck's own flip code (deck-flip.ts, bundled in), so the
// motion shows too. Run: npx vite-node scripts/deck-preview.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { inkwellDeck, inkwellThreads, INVENTORY_NOW as NOW } from "../inkwell-fixtures.js";
import { availability, cardScreen, hintKeys, overviewScreen, stripChips, type KeyContext } from "../deck-view-model.js";
import { deckRing } from "../deck-place.js";
import { DeckPane } from "../deck-screen.js";

const css = new URL("../dist/app.css", import.meta.url);
if (!existsSync(css)) throw new Error("Run bb plugin build first: the preview reads dist/app.css.");
const noop = () => {};
const none = { rows: {}, at: {} };
/** Sample notes, so the Notes tile shows: Shelf order's collapsed to their first line, Store pickup's open. */
const NOTES: Record<string, string> = { "effort-shelf-order": "## Flags\n- shelf_v2 on for staff\n\nExperiment: sort by genre first.",
  "effort-store-pickup": "Pickup window copy waits on legal.\n\n- [ ] confirm hours with the stores" };
const deck = inkwellDeck(inkwellThreads());
const view = { ...deck, active: deck.active.map((item) => NOTES[item.id] ? { ...item, notes: { body: NOTES[item.id]!, revision: 1, updatedAt: NOW } } : item) };
const order = view.active.map((item) => item.id);
const cards = new Map(view.active.map((item) => [item.id, cardScreen(item, none, { now: NOW })]));
const ring = deckRing(order);
const pane = (cur: string) => {
  const card = cards.get(cur) ?? null;
  const context: KeyContext = { view: "deck", cur: card ?? (cur === "overview" ? "overview" : null), service: order.find((id) => cards.get(id)?.card.kind === "service") ?? null, focused: null, selected: [],
    seenAvailable: false, undo: false, held: view.held.length, done: view.done.length };
  const on = availability(context);
  return renderToStaticMarkup(createElement(DeckPane, {
    chips: stripChips(order, cards, cur), cur, card, overview: cur === "overview" ? overviewScreen(order, cards) : null,
    rules: [{ id: "r1", text: "Branch shelf/* → Shelf order · 2 this week" }],
    held: view.held.map((item) => ({ id: item.id, key: item.key, name: item.name, note: `${item.reason || "No reason given"} · ${item.stats.open} open` })),
    done: view.done.map((item) => ({ id: item.id, key: item.key, name: item.name, archived: item.archived, note: `${item.merged} merged · ${item.open} open` })),
    read: { text: "Read 25s ago", error: null }, seen: { changed: 0, available: false, note: null },
    state: { selected: new Set<string>(), expanded: new Set<string>(), focus: null }, tiles: new Set(cur === "effort-store-pickup" ? ["notes"] : []), open: new Set<string>(),
    pile: null, stuck: false,
    on, hints: hintKeys(context, on), flash: null, batch: { kinds: [] }, run: noop, onPalette: noop, onHelp: noop, onUndo: noop }));
};
// Every card's pane waits in a template. A flip does what the deck does: it lands at once, copying the card it takes away first, then
// plays its motion over the pane it swapped in. The frame's data-cur names the card shown, for a check to read.
const harness = `import { flipper, ghostOf, playFlip } from "./deck-flip";
const ring = ${JSON.stringify(ring)};
const frame = document.querySelector("[data-deck-frame]");
const parts = decodeURIComponent(location.hash.slice(1)).split(",");
if (parts.includes("light")) document.documentElement.className = "light";
const pane = (id) => document.querySelector('template[data-card="' + CSS.escape(id) + '"]').content.cloneNode(true);
const flips = flipper();
let cur = ring.find((id) => parts.includes(id)) ?? ring[0];
frame.replaceChildren(pane(cur));
frame.dataset.cur = cur;
function go(step) {
  const next = flips(ring, cur, { step }, performance.now(), matchMedia("(prefers-reduced-motion: reduce)").matches);
  if (!next) return;
  const ghost = next.motion.kind === "none" ? null : ghostOf(frame);
  frame.replaceChildren(pane(next.id));
  cur = frame.dataset.cur = next.id;
  playFlip(frame, { direction: next.direction, motion: next.motion, ghost });
}
addEventListener("keydown", (event) => {
  const step = event.key === "]" || event.key === "ArrowRight" ? 1 : event.key === "[" || event.key === "ArrowLeft" ? -1 : 0;
  if (step) { event.preventDefault(); go(step); }
});
frame.addEventListener("click", (event) => {
  if (event.target.closest("[data-deck-peek], [data-deck-focus=next]")) go(1);
  else if (event.target.closest("[data-deck-focus=prev]")) go(-1);
});`;
const bundled = await build({ stdin: { contents: harness, resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "js" }, bundle: true, write: false,
  format: "esm", platform: "browser", logLevel: "silent" });
const script = bundled.outputFiles[0]!.text;
const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>Deck preview</title><style>
:root{color-scheme:dark;--background:#151515;--foreground:#e6e6e6;--card:#1b1b1b;--popover:#1f1f1f;--popover-foreground:#e6e6e6;--muted:#232323;
--muted-foreground:#9a9a9a;--border:#2c2c2c;--input:#333;--ring:#6b8afd;--destructive:#f07178;--state-hover:#ffffff10;--state-active:#ffffff18;--radius:6px}
:root.light{color-scheme:light;--background:#ffffff;--foreground:#1c1c1c;--card:#ffffff;--popover:#ffffff;--popover-foreground:#1c1c1c;--muted:#f4f4f4;
--muted-foreground:#6e6e6e;--border:#e4e4e4;--input:#dcdcdc;--destructive:#d23f4a;--state-hover:#0000000a;--state-active:#00000012}
@layer theme,base,utilities;@layer base{*,::before,::after{box-sizing:border-box;margin:0;padding:0;border:0 solid}
button,input{font:inherit;color:inherit;background:transparent;text-align:inherit}h1,h2{font-size:inherit;font-weight:inherit}svg{display:block}}
body{margin:0;background:var(--background);color:var(--foreground);font:13px/1.45 system-ui,-apple-system,sans-serif}
</style><style>${readFileSync(css, "utf8")}</style></head><body>
<section data-deck-frame data-bb-plugin="workstreams" style="position:fixed;inset:0;display:flex">${pane(ring[0]!)}</section>
${ring.map((id) => `<template data-card="${id}">${pane(id)}</template>`).join("\n")}
<script type="module">${script}</script></body></html>`;
const out = join(process.env.TMPDIR ?? tmpdir(), "deck-preview.html");
writeFileSync(out, html);
console.log(out);
