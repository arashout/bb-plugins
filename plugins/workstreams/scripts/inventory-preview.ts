// Render the PR inventory's acceptance fixture to static HTML for a visual
// check, since installing this build migrates the live store: Address's
// states on Your turn, a PR it left out, and the selection bar's refusal. It
// writes only $TMPDIR/inventory-preview.html, styled by the last `bb plugin
// build`'s dist/app.css over dark host colors and a minimal Preflight, both of
// which the host supplies. Run: npx vite-node scripts/inventory-preview.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { inkwellInventory, INVENTORY_NOW as NOW } from "../inkwell-fixtures.js";
import type { InventoryView } from "../inventory-view.js";
import { inventoryScreen } from "../inventory-view-model.js";
import { InventoryPane } from "../inventory-screen.js";
import type { Sent } from "../your-turn.js";

const css = new URL("../dist/app.css", import.meta.url);
if (!existsSync(css)) throw new Error("Run bb plugin build first: the preview reads dist/app.css.");
const noop = () => {};
const base = inkwellInventory();
// One held row, one failed read, and a rate limit, so each notice and mark shows.
const view: InventoryView = { ...base, rateLimitedUntil: NOW + 4 * 60_000, groups: base.groups.map((group) => ({ ...group, rows: group.rows.map((row) =>
  row.number === 318 ? { ...row, hold: { reason: "Wait for the store launch", heldAt: NOW - 3 * 3_600_000 }, attention: [], status: "On hold" }
    : row.number === 97 ? { ...row, failure: { at: new Date(NOW - 90_000).toISOString(), error: "HTTP 502" } }
      : row.number === 96 ? { ...row, lastAction: { at: NOW - 120_000, action: "nudge" as const, ok: false, reviewers: [],
        detail: "Who needs a nudge changed since the row was shown (now @mira-l). Review it and try again; nothing was written." } } : row) })) };
/** Address's states: each sent PR's thread link and status, a PR the last Address didn't send, and why it started nothing. */
const sent = (state: Sent["state"], detail: string | null = null, threadId: string | null = "thr_batch") =>
  ({ state, threadId, title: "Address feedback on 4 PRs", detail, batchId: state === "sending" ? "b-1" : null });
const states = (by: Record<number, Sent>) => ({ ...base, groups: base.groups.map((group) => ({ ...group, rows: group.rows.map((row) => by[row.number]
  ? { ...row, sent: by[row.number]!, addressing: by[row.number]!.state === "working" || by[row.number]!.state === "needs-you" ? { threadId: "thr_batch", title: null } : null }
  : row) })) });
const tracked = states({ 210: sent("working"), 211: sent("needs-you"), 155: sent("idle"), 301: sent("idle") });
const starting = states({ 210: sent("sending", null, null), 211: sent("refused", "On hold. Release it first.", null) });
const left = new Map([["https://github.com/inkwell/spine/pull/155", "An agent is working in its checkout."]]);
const pane = (shown: InventoryView, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(InventoryPane, {
  screen: inventoryScreen(shown, { now: NOW, filter: null }), busyKey: null, error: null,
  onView: noop, onPalette: noop, onHelp: noop, onOpenPr: noop, onOpenThread: noop, onOpenRoster: noop, onNudge: noop,
  selected: new Set<string>(), onSelect: noop, onSelectAll: noop, onAddress: noop, onClear: noop, onUndo: noop, ...extra }));
const frame = (width: number, body: string) =>
  `<section style="width:${width}px;height:1100px;border:1px solid #2a2a2a;flex:none;display:flex" data-bb-plugin="workstreams">${body}</section>`;
const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>Inventory preview</title><style>
:root{color-scheme:dark;--background:#151515;--foreground:#e6e6e6;--card:#1b1b1b;--popover:#1f1f1f;--popover-foreground:#e6e6e6;--muted:#232323;
--muted-foreground:#9a9a9a;--border:#2c2c2c;--input:#333;--ring:#6b8afd;--destructive:#f07178;--state-hover:#ffffff10;--state-active:#ffffff18;--radius:6px}
@layer theme,base,utilities;@layer base{*,::before,::after{box-sizing:border-box;margin:0;padding:0;border:0 solid}
button,input{font:inherit;color:inherit;background:transparent;text-align:inherit}h1,h2{font-size:inherit;font-weight:inherit}svg{display:block}
table{border-collapse:collapse}}
body{margin:0;padding:16px;background:#101010;color:var(--foreground);font:13px/1.45 system-ui,-apple-system,sans-serif;display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
</style><style>${readFileSync(css, "utf8")}</style></head><body>${frame(1280, pane(tracked))}${frame(560, pane(starting, { notes: left,
  selected: new Set(["https://github.com/inkwell/spine/pull/155", "https://github.com/inkwell/folio/pull/301"]),
  refusal: "Nothing started. spine #155: An agent is working in its checkout." }))}${frame(420, pane(view))}</body></html>`;
const out = join(process.env.TMPDIR ?? tmpdir(), "inventory-preview.html");
writeFileSync(out, html);
console.log(out);
