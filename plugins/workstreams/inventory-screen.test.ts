import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { inkwellInventory, INVENTORY_NOW as NOW } from "./inkwell-fixtures.js";
import type { InventoryView } from "./inventory-view.js";
import { actionCall, inventoryScreen, yourTurnRows, type InventoryLine } from "./inventory-view-model.js";
import { InventoryPane, InventoryPending, splitInventory } from "./inventory-screen.js";
import { MergePreviewBody, mergeTrigger, type MergePreview } from "./roster-merge-dialog.js";

const VIEW = inkwellInventory();
const SCREEN = inventoryScreen(VIEW, { now: NOW, filter: null });
const noop = () => {};
const CALLBACKS = { busyKey: null, onView: noop, onPalette: noop, onHelp: noop, onOpenPr: noop, onOpenThread: noop, onOpenRoster: noop, onNudge: noop, onAsk: noop };
function pane(view: InventoryView = VIEW) {
  return renderToStaticMarkup(createElement(InventoryPane, { screen: view === VIEW ? SCREEN : inventoryScreen(view, { now: NOW, filter: null }), error: null, ...CALLBACKS }));
}
/** The view with each row `patch` names changed. */
const patched = (patch: (row: InventoryView["groups"][number]["rows"][number]) => Partial<InventoryView["groups"][number]["rows"][number]> | null): InventoryView =>
  ({ ...VIEW, groups: VIEW.groups.map((group) => ({ ...group, rows: group.rows.map((row) => ({ ...row, ...patch(row) })) })) });
const refs = (groups: ReturnType<typeof splitInventory>["turn"]) => groups.map((group) => [group.label, group.lines.map((line) => `${line.slug}#${line.number}`)]);
const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/&quot;/gu, '"').replace(/&#x27;/gu, "'").replace(/&amp;/gu, "&").replace(/\s+/gu, " ");
const line = (pr: string): InventoryLine => SCREEN.groups.flatMap((group) => group.lines).find((item) => `${item.repo} #${item.number}` === pr)!;
/** One row's markup, from its start to the next row's. */
const rowOf = (html: string, ref: string) => { const start = html.indexOf(`data-inventory-row="${ref}"`); return html.slice(start, html.indexOf("data-inventory-row=", start + 20)); };

describe("simple All PRs list", () => {
  // The server marks Your turn: the three change requests and the two approvals with comments. CI, conflicts, and waits stay below.
  it("puts Your turn first by effort, and shows each PR in only one list", () => {
    const parts = splitInventory(SCREEN);
    expect(refs(parts.turn)).toEqual([["Store pickup", ["inkwell/quill#210", "inkwell/quill#211", "inkwell/spine#155"]],
      ["No effort", ["inkwell/folio#301", "inkwell/folio#318"]]]);
    const turn = new Set(parts.turn.flatMap((group) => group.lines.map((line) => line.prUrl)));
    expect(parts.other.flatMap((group) => group.lines).filter((line) => turn.has(line.prUrl))).toEqual([]);
    expect(parts.other.flatMap((group) => group.lines).map((line) => line.number)).toEqual(expect.arrayContaining([305, 330, 96]));
    const html = pane();
    expect(html).toContain("Your turn");
    expect(html).not.toContain("Back to me");
    expect(html).toContain("Other open PRs");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("Filter by question");
  });

  // The badge counts what the list shows, so the two never disagree.
  it("counts Your turn as the list shows it, under its heading and in the badge", () => {
    for (const view of [VIEW, patched((row) => row.number === 318 ? { yourTurn: null } : null), patched(() => ({ yourTurn: null }))]) {
      const listed = splitInventory(inventoryScreen(view, { now: NOW, filter: null })).turn.flatMap((group) => group.lines).length;
      expect(yourTurnRows(view, NOW)).toHaveLength(listed);
      expect(text(pane(view))).toContain(`Your turn ${listed} `);
    }
    expect(yourTurnRows(VIEW, NOW)).toHaveLength(5);
  });

  // The deck files a PR a thread is fixing now In flight, and a held effort's PRs wait with it, so neither asks anything of you yet: the list
  // and the badge leave both out until the thread stops or you resume the effort.
  it("leaves out a PR a thread is working on and a held effort's PRs, in the list and the badge alike", () => {
    const turn = (view: InventoryView) => refs(splitInventory(inventoryScreen(view, { now: NOW, filter: null })).turn);
    const working = patched((row) => row.number === 211 ? { threads: { ...row.threads, executor: { ...row.threads.executor!, active: true } } } : null);
    expect(turn(working)).toEqual([["Store pickup", ["inkwell/quill#210", "inkwell/spine#155"]], ["No effort", ["inkwell/folio#301", "inkwell/folio#318"]]]);
    const held: InventoryView = { ...VIEW, groups: VIEW.groups.map((group) => group.effort?.id === "effort-store-pickup" ? { ...group, effort: { ...group.effort, pile: "held" } } : group) };
    expect(turn(held)).toEqual([["No effort", ["inkwell/folio#301", "inkwell/folio#318"]]]);
    for (const view of [working, held]) expect(yourTurnRows(view, NOW)).toHaveLength(turn(view).flatMap(([, lines]) => lines).length);
  });

  it("says why it's your turn and since when, with Open thread where the PR has a thread", () => {
    const html = pane();
    expect(text(rowOf(html, "inkwell/quill#210"))).toContain("ABC-370 Hold books at the counter Changes requested by @otto-v · 1d Open thread");
    expect(text(rowOf(html, "inkwell/folio#301"))).toContain("ABC-350 Show spine labels on shelf cards Approval comment to address · 2d");
    expect(rowOf(html, "inkwell/folio#301")).not.toContain("Open thread");
    // Other open PRs lead with their state and next step, and never with Open thread.
    expect(rowOf(html, "inkwell/folio#330")).not.toContain("Open thread");
    expect(html).not.toContain(">Start<");
  });

  // Ask goes through the deck's listing confirm, so it shows only where the deck would take it: the approval's notes, or a thread's work
  // that no thread is doing right now. It reuses the PR's own thread and never starts one, a Reviews item, or a write on its own.
  it("offers Ask its thread on Your turn rows with a thread the deck's listing takes, and nowhere else", () => {
    const asks = (html: string) => [...html.matchAll(/data-inventory-row="([^"]+)"(?:(?!data-inventory-row=).)*?data-inventory-action="ask"/gsu)].map((match) => match[1]);
    expect(asks(pane())).toEqual(["inkwell/quill#210", "inkwell/quill#211", "inkwell/spine#155"]);
    // The two approvals with comments have no thread yet: nothing to ask, and nothing started for them.
    expect(rowOf(pane(), "inkwell/folio#301")).not.toContain("Ask its thread");
    const threaded = patched((row) => row.number === 301 ? { threads: { origin: { id: "thr_folio_301", title: "Spine labels", active: false }, executor: null } } : null);
    expect(asks(pane(threaded))).toEqual(["inkwell/quill#210", "inkwell/quill#211", "inkwell/spine#155", "inkwell/folio#301"]);
    expect(rowOf(pane(threaded), "inkwell/folio#301")).toMatch(/title="Ask its thread to address the approval&#x27;s notes\. You confirm the listing first, then Undo for 8 s\."/u);
    // A thread working on it now has the work in hand: no other ask, and it's not your turn.
    const working = patched((row) => row.number === 211 ? { threads: { ...row.threads, executor: { ...row.threads.executor!, active: true } } } : null);
    expect(asks(pane(working))).not.toContain("inkwell/quill#211");
    // A held effort's PRs wait with it.
    const held: InventoryView = { ...threaded, groups: threaded.groups.map((group) => group.effort?.id === "effort-store-pickup" ? { ...group, effort: { ...group.effort, pile: "held" } } : group) };
    expect(asks(pane(held))).toEqual(["inkwell/folio#301"]);
  });

  it("says when no feedback waits on you", () => {
    expect(text(pane(patched(() => ({ yourTurn: null }))))).toContain("Your turn 0 No feedback waits on you.");
  });

  it("offers Nudge only where the inventory action is enabled", () => {
    const html = pane();
    expect((html.match(/data-inventory-action="nudge"/gu) ?? [])).toHaveLength(1);
    expect(html).not.toContain("data-inventory-action=\"merge\"");
    expect(html).not.toContain("data-inventory-action=\"request-review\"");
  });

  it("keeps the primary read notice visible and folds many other notices without dropping their text or roles", () => {
    const notices = [{ tone: "error" as const, text: "GitHub rate limited this read." },
      ...Array.from({ length: 24 }, (_, index) => ({ tone: "info" as const, text: `Repository ${index + 1} needs a read.` }))];
    const html = renderToStaticMarkup(createElement(InventoryPane, { screen: { ...SCREEN, notices }, error: "Inventory request failed", ...CALLBACKS }));
    expect(html).toMatch(/role="alert"[^>]*>Couldn&#x27;t read the inventory: Inventory request failed/gu);
    expect(html).toMatch(/role="alert"[^>]*>GitHub rate limited this read\.<\/p><details/gu);
    expect(html).toContain("<summary");
    expect(html).toContain("24 more inventory notices");
    expect(html).not.toContain("<details open");
    expect(html).toContain("Repository 24 needs a read.");
    expect(html.indexOf("</details>")).toBeLessThan(html.indexOf("Your turn"));
  });

  it("keeps tabs and retry visible when the first inventory read fails", () => {
    const html = renderToStaticMarkup(createElement(InventoryPending, { error: "HTTP 500", onRetry: noop, onView: noop, onPalette: noop, onHelp: noop }));
    expect(html).toContain("All PRs");
    expect(html).toContain("Couldn&#x27;t read the inventory: HTTP 500");
    expect(html).toContain("Retry");
  });

  it("links each effort's group to its roster, with No effort last and plain", () => {
    const html = pane();
    const heading = (label: string) => html.slice(html.indexOf(`data-inventory-group="${label}"`), html.indexOf("</h3>", html.indexOf(`data-inventory-group="${label}"`)));
    expect(heading("Shelf order")).toMatch(/<button type="button"[^>]*>Shelf order<\/button>$/u);
    expect(heading("Store pickup")).toMatch(/<button type="button"[^>]*>Store pickup<\/button>$/u);
    expect(html.indexOf('data-inventory-group="No effort"')).toBeGreaterThan(html.indexOf('data-inventory-group="Store pickup"'));
    expect(heading("No effort")).not.toContain("<button");
  });

  it("shows each row's state word and next step with its age", () => {
    const words = text(pane());
    expect(words).toContain("inkwell/catalog #96 ABC-121 Show series order on catalog pages Awaiting review · Nudge @mira-l, @theo-k · 2d Nudge");
    expect(words).toContain("inkwell/folio #330 ABC-364 Keep shelf filters in the link Conflicts · Resolve the conflicts · 2d+");
    expect(words).toContain("inkwell/quill #212 ABC-372 Email when a hold is ready Behind #210 · Waits on #210");
  });

  // Confirming review notes is the deck's: one PR's notes, read fresh, in its confirm. All PRs shows the wait and offers no way around it.
  it("lists an approval with comments as your turn, with no Confirm handled or Merge… here", () => {
    for (const ref of ["inkwell/folio#301", "inkwell/folio#318"]) {
      const row = rowOf(pane(), ref);
      expect(text(row)).toContain("Approval comment to address · 2d");
      expect(row).not.toContain('data-inventory-action="confirm-handled"');
      expect(row).not.toContain('data-inventory-action="merge"');
    }
  });

  it("keeps every row's PR number outside the part that truncates, so a long repo name never hides it", () => {
    const long = "inkwell/a-repository-name-long-enough-to-truncate-in-any-pane";
    const html = pane(patched((row) => row.number === 96 || row.number === 210 ? { repo: long } : null));
    const numbers = [...html.matchAll(/<span class="min-w-0 truncate">([^<]*)<\/span><span class="shrink-0">#(\d+)<\/span>/gu)];
    expect(numbers).toHaveLength(17);
    for (const [, repo] of numbers) expect(repo).not.toMatch(/#\d/u);
    expect(numbers.map((match) => `${match[1]}#${match[2]}`)).toEqual(expect.arrayContaining([`${long}#96`, `${long}#210`]));
  });

  it("shows a row's last action, or the server's refusal word for word, under its next step", () => {
    const refused = "Who needs a nudge changed since the row was shown (now @mira-l). Review it and try again; nothing was written.";
    const view = { ...VIEW, groups: VIEW.groups.map((group) => ({ ...group, rows: group.rows.map((row) => row.number === 96
      ? { ...row, lastAction: { at: NOW - 60_000, action: "nudge" as const, ok: false, detail: refused, reviewers: [] } } : row) })) };
    expect(pane(view)).toMatch(new RegExp(`<p role="status" class="[^"]*text-destructive"[^>]*>Nudge refused 1m ago: ${refused.replace(/[().]/gu, "\\$&")}</p>`, "u"));
  });

  it("shows the rate limit and a failed read as alerts naming the reset", () => {
    const html = pane({ ...VIEW, rateLimitedUntil: NOW + 5 * 60_000 });
    expect(html).toMatch(/role="alert"[^>]*>.*?GitHub&#x27;s rate limit holds reads until \d{2}:\d{2}\. Rows show the last good read\./u);
    const failed = renderToStaticMarkup(createElement(InventoryPane, { screen: SCREEN, error: "HTTP 500", ...CALLBACKS }));
    expect(failed).toContain('role="alert" class="text-[12px] text-destructive">Couldn&#x27;t read the inventory: HTTP 500');
  });

  it("keeps every text size at 11px or larger, uses no amber, and animates only when motion is allowed", () => {
    const busy = { ...VIEW, refreshing: true };
    for (const html of [pane(), pane(busy)]) {
      // The shared header's key badges are the deck's own, whose contrast deck-badges.test.ts checks; All PRs' text stays 11px or larger.
      expect(html.replace(/<header data-ws-header[\s\S]*?<\/header>/u, "")).not.toMatch(/text-\[(?:[0-9]|10)(?:\.\d+)?px\]|text-\[0\.\d+rem\]|text-xs/u);
      expect(html).not.toMatch(/\bamber-/u);
      expect(html).not.toMatch(/(?<!motion-safe:)\banimate-/u);
      expect(html).not.toMatch(/#[0-9a-f]{6}\b/iu);
    }
    expect(pane(busy)).toContain("motion-safe:animate-spin");
  });
});

describe("All PRs beside the effort deck", () => {
  // Holding an effort holds its PRs, so a Nudge there would only be refused; a done or archived effort's rows offer none either.
  it("offers no Nudge on a held, done, or archived effort's rows, and keeps the rows in view", () => {
    const piled = (pile: "held" | "done" | "archived"): InventoryView => ({ ...VIEW, groups: VIEW.groups.map((group) => group.effort === null
      ? { ...group, effort: { id: "effort-loose", name: "Loose ends", pile } } : group) });
    expect(rowOf(pane(), "inkwell/catalog#96")).toContain('data-inventory-action="nudge"');
    for (const pile of ["held", "done", "archived"] as const) {
      const html = pane(piled(pile));
      expect(html).not.toContain('data-inventory-action="nudge"');
      expect(html).toContain('data-inventory-row="inkwell/catalog#96"');
    }
  });

  // A per-PR hold suppresses every step the row would name, so its Nudge goes too, until you release it in the deck.
  it("offers no Nudge on a held PR", () => {
    const held: InventoryView = { ...VIEW, groups: VIEW.groups.map((group) => ({ ...group, rows: group.rows.map((row) => row.number === 96
      ? { ...row, hold: { reason: "Waiting on the catalog redesign", heldAt: NOW - 3_600_000 }, attention: [], status: "On hold" } : row) })) };
    const row = rowOf(pane(held), "inkwell/catalog#96");
    expect(text(row)).toContain("On hold");
    expect(row).not.toContain('data-inventory-action="nudge"');
  });

  it("lets j and k focus rows for the deck's keys, with the same accent ring", () => {
    const html = pane();
    const rows = [...html.matchAll(/<li data-inventory-row="[^"]+" tabindex="-1" class="([^"]+)"/gu)];
    expect(rows).toHaveLength(17);
    expect(rows.every((match) => match[1]!.includes("focus-visible:ring-sky-500"))).toBe(true);
  });
});

describe("the inventory before its first read", () => {
  it("keeps the shared header while it reads or when the read failed, so every other view stays one click away", () => {
    const pending = (error: string | null) => renderToStaticMarkup(createElement(InventoryPending, { error, onRetry: noop, onView: noop, onPalette: noop, onHelp: noop }));
    for (const html of [pending(null), pending("HTTP 500")]) {
      expect(html).toContain('data-ws-header="inventory"');
      expect([...html.matchAll(/<nav aria-label="Workstreams views"[^>]*>(.*?)<\/nav>/gu)].map((match) => text(match[1]!).trim())).toEqual(["Efforts All PRs"]);
      expect(text(html)).toContain("More ▾");
    }
    expect(text(pending(null))).toContain("Reading your open PRs…");
    const failed = pending("HTTP 500");
    expect(failed).toContain('role="alert"');
    expect(failed).toMatch(/<button type="button" class="[^"]*focus-visible:ring-2[^"]*">Retry<\/button>/u);
    expect(text(failed)).toContain("Couldn't read the inventory: HTTP 500 Retry");
  });
});

describe("selecting Your turn PRs to address together", () => {
  const selectedPane = (selected: ReadonlySet<string>, view: InventoryView = VIEW) => renderToStaticMarkup(createElement(InventoryPane, {
    screen: view === VIEW ? SCREEN : inventoryScreen(view, { now: NOW, filter: null }), error: null, ...CALLBACKS, selected, onSelect: noop, onSelectAll: noop,
    onAddress: noop, onClear: noop }));
  const boxes = (html: string) => [...html.matchAll(/aria-label="Select (inkwell\/[^"]+)"/gu)].map((match) => match[1]);

  // Only Your turn's rows take a checkbox, so Address selected never reaches a PR with nothing waiting on you.
  it("offers a checkbox on each Your turn row and a box for the whole list, and none on other rows", () => {
    const html = selectedPane(new Set());
    expect(boxes(html)).toEqual(["inkwell/quill#210", "inkwell/quill#211", "inkwell/spine#155", "inkwell/folio#301", "inkwell/folio#318"]);
    expect(html).toContain('aria-label="Select every Your turn PR"');
    // Nothing selected, nothing to address: the bar stays away.
    expect(html).not.toContain('data-inventory-action="address"');
    // Without the handlers, as before, the rows draw no checkbox.
    expect(boxes(pane())).toEqual([]);
  });

  it("shows the selection with Address selected (N) and its key, and Clear", () => {
    const picked = new Set(["https://github.com/inkwell/quill/pull/210", "https://github.com/inkwell/folio/pull/301"]);
    const html = selectedPane(picked);
    expect(rowOf(html, "inkwell/quill#210")).toContain('data-inventory-selected="true"');
    expect(rowOf(html, "inkwell/quill#211")).not.toContain("data-inventory-selected");
    expect(text(html)).toContain("2 selected Address selected (2) b Clear esc");
    expect(html).toMatch(/data-inventory-action="address" title="Lists each PR first, then sends after 8 s with Undo\. Nothing merges\."/u);
    // Every row selected: the list's box reads as clearing them.
    expect(selectedPane(new Set(yourTurnRows(VIEW, NOW).map((line) => line.prUrl)))).toContain('aria-label="Clear the selection"');
  });

  // A batch thread holds it now: it's off Your turn and can't be picked again, and the row links the thread doing the work.
  it("lists a PR a batch thread holds under Other open PRs as Addressing, with a link to the thread", () => {
    const view = patched((row) => row.number === 210 ? { addressing: { threadId: "thr-batch", title: "Address feedback on 2 PRs" } }
      : row.number === 211 ? { addressing: { threadId: null, title: null } } : null);
    const html = selectedPane(new Set(), view);
    expect(boxes(html)).toEqual(["inkwell/spine#155", "inkwell/folio#301", "inkwell/folio#318"]);
    expect(text(rowOf(html, "inkwell/quill#210"))).toContain("Addressing · batch thread");
    expect(rowOf(html, "inkwell/quill#210")).toMatch(/data-inventory-addressing[^>]*>Addressing · <button type="button"/u);
    expect(text(rowOf(html, "inkwell/quill#211"))).toContain("Addressing · starting its batch thread");
  });
});

describe("keyboard safety", () => {
  // All PRs offers no merge at all; the deck's Merge… opens the same fresh preview, whose Merge button refuses Enter and Space.
  it("never merges from All PRs, and a row's merge only opens the fresh preview, whose Merge refuses Enter", () => {
    for (const html of [pane(), pane(patched(() => ({ yourTurn: null })))]) {
      expect(html).not.toContain('data-inventory-action="merge"');
      expect(html).not.toContain("data-merge-go");
    }
    const url = "https://github.com/inkwell/folio/pull/340";
    const row = VIEW.groups.flatMap((group) => group.rows).find((entry) => entry.prUrl === url)!;
    // A row's merge action carries no head to merge: it only opens the preview.
    expect(actionCall(row, line("folio #340").actions.find((entry) => entry.id === "merge")!)).toEqual({ kind: "preview", target: url });
    // In the preview, Enter or Space on Merge arrives as a click with detail 0 and is refused; only a pointer click or ⌘↵ merges.
    expect(mergeTrigger({ kind: "click", detail: 0 })).toBe("refuse");
    expect(mergeTrigger({ kind: "key", key: "Enter", metaKey: false, ctrlKey: false })).toBeNull();
    expect(mergeTrigger({ kind: "key", key: "Enter", metaKey: true, ctrlKey: false })).toBe("merge");
    // The preview names an unnumbered PR by repository and number, pinned to the head it read.
    const preview: MergePreview = { ok: true, live: { state: "OPEN", isDraft: false, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", headRefOid: row.head,
      stackedAbove: [], unresolvedThreads: 0, unresolvedAtLeast: false, approvalNotes: [], approvalNotesMore: 0, approvalNotesComplete: true },
      refusals: [], warnings: [], method: "squash", deleteBranch: true };
    const html = renderToStaticMarkup(createElement(MergePreviewBody, { items: [{ n: null, target: url, repo: "folio", number: 340, title: row.title, preview, result: null }],
      selected: new Set([url]), busy: false, notice: null, onToggle: noop, onMerge: noop, onCancel: noop, onOpenUrl: noop }));
    expect(text(html)).toContain(`folio #340 ${row.title} head ${row.head!.slice(0, 7)}`);
    expect(html).toMatch(/data-merge-go="true" title="Click, or press ⌘↵\. Merging needs ⌘↵ or a click; Enter alone doesn&#x27;t merge\."/u);
  });
});
