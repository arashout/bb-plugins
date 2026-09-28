// Render the roster pane's fixture to static HTML for a visual check, since
// installing a v2 build migrates the live store. It writes only
// $TMPDIR/roster-preview.html, styled by the last `bb plugin build`'s
// dist/app.css over dark host colors and a minimal Preflight, both of which
// the host supplies. Run: npx vite-node scripts/roster-preview.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { INKWELL_SHELVING_ROSTER as ROSTER, SHELVING_ROSTER_NOW as NOW } from "../inkwell-fixtures.js";
import { ackView, askCards, rosterView, settle, type RosterOrder } from "../roster-view-model.js";
import { RosterPane } from "../roster-view.js";

const css = new URL("../dist/app.css", import.meta.url);
if (!existsSync(css)) throw new Error("Run bb plugin build first: the preview reads dist/app.css.");
const noop = () => {};
const pane = (wide: boolean, order: RosterOrder) => renderToStaticMarkup(createElement(RosterPane, {
  view: rosterView(ROSTER, { order, now: NOW, settled: settle(ROSTER), seen: { seq: 400, at: NOW - (2 * 60 + 16) * 60_000 } }),
  wide, mount: wide ? "nav" : "tab", live: true, order, focusN: 5, menuN: null, liveThreads: new Set(["thr_folio_entry"]),
  command: { value: wide ? "" : "hold 8 because ", onValue: noop, onSubmit: noop, ack: ackView({ ...ROSTER.lastCommand!, fresh: wide }, NOW), open: wide, onToggle: noop,
    onLeave: noop, note: null },
  asks: { ...askCards(ROSTER), wide, now: NOW, state: { focus: { ask: "D1" }, open: wide ? null : "D1", picks: new Map(), subsets: new Map(), hint: null },
    onFocusAsk: noop, onFocus: noop, onAnswer: noop, onField: noop, onSubset: noop, onCompose: noop, onUndo: noop, onRecover: noop, onOpenThread: noop, onOpenUrl: noop },
  history: ROSTER.history, hasParent: true, onOrder: noop, onMarkSeen: noop, onHeader: noop, onFocus: noop, onCompose: noop, onMenu: noop, onAction: noop,
  onToggleGroup: noop, onOpenUrl: noop,
}));
const frame = (width: number, wide: boolean, order: RosterOrder) =>
  `<section style="width:${width}px;height:900px;border:1px solid #2a2a2a;flex:none" data-bb-plugin="workstreams">${pane(wide, order)}</section>`;
const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>Roster preview</title><style>
:root{color-scheme:dark;--background:#151515;--foreground:#e6e6e6;--card:#1b1b1b;--popover:#1f1f1f;--popover-foreground:#e6e6e6;--muted:#232323;
--muted-foreground:#9a9a9a;--border:#2c2c2c;--input:#333;--ring:#6b8afd;--destructive:#f07178;--state-hover:#ffffff10;--state-active:#ffffff18;--radius:6px}
@layer theme,base,utilities;@layer base{*,::before,::after{box-sizing:border-box;margin:0;padding:0;border:0 solid}
button,input{font:inherit;color:inherit;background:transparent;text-align:inherit}h2{font-size:inherit;font-weight:inherit}svg{display:block}}
body{margin:0;padding:16px;background:#101010;color:var(--foreground);font:13px/1.45 system-ui,-apple-system,sans-serif;display:flex;gap:16px;align-items:flex-start}
</style><style>${readFileSync(css, "utf8")}</style></head><body>${frame(1280, true, "number")}${frame(420, false, "number")}${frame(560, false, "state")}</body></html>`;
const out = join(process.env.TMPDIR ?? tmpdir(), "roster-preview.html");
writeFileSync(out, html);
console.log(out);
