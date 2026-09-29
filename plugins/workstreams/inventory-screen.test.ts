import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { inkwellInventory, INVENTORY_NOW as NOW } from "./inkwell-fixtures.js";
import type { InventoryQuestion, InventoryView } from "./inventory-view.js";
import { actionCall, inventoryScreen, type InventoryLine } from "./inventory-view-model.js";
import { ReviewerPickerBody, TABLE_MIN_WIDTH } from "./inventory-rows.js";
import { InventoryPane, InventoryPending } from "./inventory-screen.js";
import { MergePreviewBody, mergeTrigger, type MergePreview } from "./roster-merge-dialog.js";

const VIEW = inkwellInventory();
const noop = () => {};
function pane(wide: boolean, view: InventoryView = VIEW, filter: InventoryQuestion | null = null, error: string | null = null) {
  return renderToStaticMarkup(createElement(InventoryPane, { screen: inventoryScreen(view, { now: NOW, filter }), wide, error, picker: null,
    onFilter: noop, onView: noop, onHow: noop, onAction: noop, onRequest: noop, onPicker: noop, onOpenPr: noop, onOpenThread: noop, onOpenRoster: noop, onHold: noop }));
}
const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/&quot;/gu, '"').replace(/&#x27;/gu, "'").replace(/&amp;/gu, "&").replace(/\s+/gu, " ");
/** The column headers, not the effort headers inside the body. */
const headers = (html: string) => [.../<thead>(.*?)<\/thead>/u.exec(html)![1]!.matchAll(/<th[^>]*>(.*?)<\/th>/gu)].map((match) => match[1]!.replace(/<[^>]+>/gu, ""));
/** Every row in document order, with its stack depth. */
const rows = (html: string) => [...html.matchAll(/data-inventory-row="inkwell\/([a-z]+)#(\d+)" data-depth="(\d)"/gu)].map((match) => `${"  ".repeat(Number(match[3]))}${match[1]} #${match[2]}`);
const line = (pr: string): InventoryLine => inventoryScreen(VIEW, { now: NOW, filter: null }).groups.flatMap((group) => group.lines).find((item) => `${item.repo} #${item.number}` === pr)!;

describe("the PR inventory screen's markup", () => {
  it("draws the dense table at 900px and up, and two-line rows below it", () => {
    const wide = pane(true);
    expect(wide).toContain("<table");
    expect(headers(wide)).toEqual(["PR", "Title", "Reviewers", "Status", "Next · owner · age", "Checked", "Actions"]);
    const narrow = pane(false);
    expect(narrow).not.toContain("<table");
    expect(narrow).toContain('role="list" aria-label="Open PRs"');
  });

  // At 900px the fixed columns left Title and Next · owner · age about 95px each, too narrow for a step with its owner and age.
  it("draws the table only in a pane wide enough for Title and Next · owner · age to show a step whole", () => {
    const cols = [...pane(true).matchAll(/<col(?: style="width:([\d.]+)(px|%)")?\/>/gu)].map((match) => match[1] ? { size: Number(match[1]), unit: match[2] } : null);
    expect(cols).toHaveLength(7);
    const fixed = cols.reduce((sum, col) => sum + (col?.unit === "px" ? col.size : 0), 0);
    const next = cols[4]!.unit === "%" ? TABLE_MIN_WIDTH * cols[4]!.size / 100 : cols[4]!.size;
    expect(cols[1]).toBeNull();
    expect(next).toBeGreaterThanOrEqual(240);
    expect(TABLE_MIN_WIDTH - fixed - next).toBeGreaterThanOrEqual(150);
  });

  it("files stacked children under their parent in stack order, in both layouts", () => {
    for (const html of [pane(true), pane(false)]) {
      const order = rows(html);
      expect(order.slice(0, 5)).toEqual(["folio #330", "folio #340", "  folio #341", "    folio #342", "      folio #343"]);
      expect(order.slice(5, 10)).toEqual(["quill #210", "  quill #212", "quill #211", "spine #155", "  spine #156"]);
      expect(order).toHaveLength(17);
    }
  });

  it("links each effort's group to its roster, with No effort last and plain", () => {
    const html = pane(true);
    expect(html).toContain('aria-label="Open the Shelf order roster"');
    expect(html).toContain('aria-label="Open the Store pickup roster"');
    expect(html.indexOf('data-inventory-group="No effort"')).toBeGreaterThan(html.indexOf('data-inventory-group="Store pickup"'));
    expect(html).not.toContain("Open the No effort roster");
  });

  it("shows each row's reviewers, state word, next step with owner and age, and when GitHub last answered", () => {
    const words = text(pane(true));
    expect(words).toContain("catalog #96 ABC-121 Show series order on catalog pages @mira-l asked , @theo-k asked Awaiting review Nudge @mira-l, @theo-k · reviewers · 2d checked 25s ago");
    expect(words).toContain("folio #330 ABC-364 Keep shelf filters in the link @mira-l approved Conflicts Resolve the conflicts · you · 2d+ checked 25s ago");
    expect(words).toContain("quill #212 ABC-372 Email when a hold is ready @otto-v approved Behind #210 Waits on #210 · #210");
    expect(words).toContain("atlas #410 ABC-210 Show delivery windows at checkout no reviewer Conflicts Request a review · you · 6d Resolve the conflicts · you · 2d+");
  });

  it("shows an approval with comments to confirm as its state, with a Confirm handled button and no Merge… yet, in both layouts", () => {
    for (const html of [pane(true), pane(false)]) {
      const row = html.slice(html.indexOf('data-inventory-row="inkwell/folio#301"'), html.indexOf('data-inventory-row="inkwell/folio#305"'));
      expect(text(row)).toContain("Approved with comments Confirm the approval's comments are handled · you · 2d");
      expect(row).toMatch(/<button[^>]*data-inventory-action="confirm-handled" aria-label="Confirm handled folio #301"[^>]*>Confirm handled<\/button>/u);
      expect(row).not.toContain('data-inventory-action="merge"');
    }
  });

  it("keeps a two-line row to its first step, with how many more outside the step's truncation", () => {
    const html = pane(false);
    const atlas = html.slice(html.indexOf('data-inventory-row="inkwell/atlas#410"'), html.indexOf('data-inventory-row="inkwell/catalog#96"'));
    expect(text(atlas)).toContain("Conflicts Request a review · you · 6d · +1");
    expect(text(atlas)).not.toContain("Resolve the conflicts · you");
    // The step truncates on its own; the count sits beside it, so an ellipsis never hides that more steps wait.
    expect(atlas).toMatch(/<span class="min-w-0 truncate">Request a review.*?<\/span><span class="shrink-0[^"]*"> · \+1<\/span>/u);
  });

  it("shows a row's last action, or the server's refusal word for word, under its next step in both layouts", () => {
    const refused = "Who needs a nudge changed since the row was shown (now @mira-l). Review it and try again; nothing was written.";
    const view = { ...VIEW, groups: VIEW.groups.map((group) => ({ ...group, rows: group.rows.map((row) => row.number === 96
      ? { ...row, lastAction: { at: NOW - 60_000, action: "nudge" as const, ok: false, detail: refused, reviewers: [] } } : row) })) };
    for (const html of [pane(true, view), pane(false, view)]) {
      expect(html).toMatch(new RegExp(`<p role="status" class="[^"]*text-destructive"[^>]*>Nudge refused 1m ago: ${refused.replace(/[().]/gu, "\\$&")}</p>`, "u"));
    }
  });

  it("filters to a count's PRs when you press it, and back to every PR when you press it again", () => {
    const pressed: (InventoryQuestion | null)[] = [];
    const counts = (filter: InventoryQuestion | null) => {
      const found: ReactElement<{ "aria-pressed": boolean; onClick(): void }>[] = [];
      // Render the pane's hook-free parts by hand, down to the count buttons, so their clicks can run without a DOM.
      const walk = (node: ReactNode): void => {
        if (Array.isArray(node)) node.forEach(walk);
        else if (isValidElement<Record<string, unknown>>(node)) {
          if (typeof node.type === "function" && "onFilter" in node.props) walk((node.type as (props: unknown) => ReactNode)(node.props));
          else if (node.type === "button" && "aria-pressed" in node.props) found.push(node as ReactElement<{ "aria-pressed": boolean; onClick(): void }>);
          else walk(node.props.children as ReactNode);
        }
      };
      walk(InventoryPane({ screen: inventoryScreen(VIEW, { now: NOW, filter }), wide: true, error: null, picker: null, onFilter: (question) => pressed.push(question),
        onView: noop, onHow: noop, onAction: noop, onRequest: noop, onPicker: noop, onOpenPr: noop, onOpenThread: noop, onOpenRoster: noop, onHold: noop }));
      return found;
    };
    counts(null)[1]!.props.onClick();
    const on = counts("missing-reviewer");
    expect(on.map((button) => button.props["aria-pressed"])).toEqual([false, true, false]);
    on[1]!.props.onClick();
    on[2]!.props.onClick();
    expect(pressed).toEqual(["missing-reviewer", null, "needs-nudge"]);
  });

  it("counts the three questions as filters, pressed when one is on", () => {
    const html = pane(true, VIEW, "missing-reviewer");
    expect(html).toContain('aria-pressed="true" aria-label="Missing a reviewer: 3. Showing only these; press to show every PR"');
    expect(html).toContain('aria-pressed="false" aria-label="Needs a nudge: 10. Show only these"');
    expect(rows(html)).toEqual(["atlas #410", "folio #305", "folio #325"]);
    expect(text(pane(true, VIEW, "forgotten-draft"))).toContain("No PR is forgotten in draft.");
  });

  it("names every action for its PR, and keeps a disabled one focusable with why it can't run", () => {
    for (const html of [pane(true), pane(false)]) {
      expect(html).toContain('aria-label="Request review… folio #325"');
      expect(html).toContain('aria-label="Merge… folio #341: unavailable, Merge #340 first; this one follows it" aria-disabled="true"');
      expect(html).toContain('aria-label="Open thread catalog #97: unavailable, No thread is linked to this PR yet" aria-disabled="true"');
      // Every action is a button with a name; none is removed from the tab order.
      const actions = [...html.matchAll(/<button[^>]*data-inventory-action="[^"]+"[^>]*>/gu)].map((match) => match[0]);
      expect(actions.length).toBeGreaterThan(17 * 2);
      for (const tag of actions) {
        expect(tag).toMatch(/aria-label="[^"]+"/u);
        expect(tag).not.toMatch(/\sdisabled=""/u);
      }
      // A button's name starts with the words it shows, so saying "click Nudge" finds it (WCAG 2.5.3, label in name).
      const shown = [...html.matchAll(/<button[^>]*data-inventory-action="[^"]+"[^>]*aria-label="([^"]+)"[^>]*>([^<]+)<\/button>/gu)];
      // The fixture's worded buttons: 3 Request review…, 1 Nudge, 2 Confirm handled, 4 Merge…, and a Hold… on each of the 17 rows; Refresh
      // and Open thread are icons named the same way.
      expect(shown).toHaveLength(27);
      for (const [, name, label] of shown) expect(text(name!).startsWith(text(label!))).toBe(true);
    }
  });

  it("links each row's existing threads, and where the work started when that's another thread", () => {
    const html = pane(true);
    expect(html).toContain('aria-label="Open thread quill #210"');
    expect(html).toContain('aria-label="Open &quot;Plan Hold books at the counter&quot;, where the work on quill #210 started"');
  });

  it("never merges from the inventory: Merge… opens the fresh preview dialog, and no control here merges on its own", () => {
    for (const html of [pane(true), pane(false)]) {
      const merges = [...html.matchAll(/<button[^>]*data-inventory-action="merge"[^>]*>/gu)].map((match) => match[0]);
      // The stack's parent and its three children, which say which PR merges first; the two approved with comments wait for your confirmation.
      expect(merges).toHaveLength(4);
      for (const tag of merges) expect(tag).toContain('aria-haspopup="dialog"');
      expect(html).not.toContain("data-merge-go");
    }
  });

  it("shows a hold as a pin, a failed read and the rate limit as alerts naming the reset, and a stale row with its dot", () => {
    const rows = VIEW.groups.map((group) => ({ ...group, rows: group.rows.map((row) => row.number === 301
      ? { ...row, hold: { reason: "Wait for the store launch", heldAt: NOW - 3_600_000 }, attention: [], status: "On hold" }
      : row.number === 318 ? { ...row, failure: { at: new Date(NOW - 60_000).toISOString(), error: "HTTP 502" }, stale: true } : row) }));
    const html = pane(true, { ...VIEW, groups: rows, rateLimitedUntil: NOW + 5 * 60_000 });
    expect(html).toContain('aria-label="Held"');
    expect(text(html)).toContain('On hold Held by you: "Wait for the store launch"');
    expect(html).toMatch(/role="alert"[^>]*>.*?GitHub&#x27;s rate limit holds reads until \d{2}:\d{2}\. Rows show the last good read\./u);
    expect(text(html)).toContain("read failed 1m ago");
    expect(html).toContain('aria-label="Stale" data-tone="stale"');
    expect(pane(true, VIEW, null, "HTTP 500")).toContain('role="alert" class="text-[12px] text-destructive">Couldn&#x27;t read the inventory: HTTP 500');
  });

  it("keeps every text size at 11px or larger, colors only stale marks amber, and animates only when motion is allowed", () => {
    const busy = { ...VIEW, refreshing: true };
    for (const html of [pane(true), pane(false), pane(true, busy), pane(false, VIEW, "needs-nudge")]) {
      expect(html).not.toMatch(/text-\[(?:[0-9]|10)(?:\.\d+)?px\]|text-\[0\.\d+rem\]|text-xs/u);
      const amber = [...html.matchAll(/<[^>]*class="[^"]*\bamber-[^"]*"[^>]*>/gu)].map((match) => match[0]);
      expect(amber.filter((tag) => !tag.includes('data-tone="stale"'))).toEqual([]);
      expect(html).not.toMatch(/(?<!motion-safe:)\banimate-/u);
      expect(html).not.toMatch(/#[0-9a-f]{6}\b/iu);
    }
    expect(pane(true, busy)).toContain("motion-safe:animate-spin");
  });
});

describe("the reviewer picker", () => {
  it("offers the PR's suggested reviewers to toggle and a labeled login field, and won't send until someone is picked", () => {
    const html = renderToStaticMarkup(createElement(ReviewerPickerBody, { line: line("folio #325"), onRequest: noop, onCancel: noop }));
    expect(html).toContain('role="group" aria-label="Suggested reviewers"');
    expect([...html.matchAll(/aria-pressed="false"[^>]*>@([a-z-]+)</gu)].map((match) => match[1])).toEqual(["mira-l", "theo-k"]);
    expect(text(html)).toContain("GitHub login");
    expect(html).toMatch(/<button[^>]*data-inventory-request="true" aria-disabled="true"[^>]*title="Pick or type a reviewer first"/u);
    const none = renderToStaticMarkup(createElement(ReviewerPickerBody, { line: line("atlas #410"), onRequest: noop, onCancel: noop }));
    expect(text(none)).toContain("No past reviewers to suggest; type a login.");
  });
});

describe("All PRs beside the effort deck", () => {
  it("keeps per-PR Hold on every row, beside the effort-level hold, and offers Release on a held row", () => {
    const held: InventoryView = { ...VIEW, groups: VIEW.groups.map((group) => ({ ...group, rows: group.rows.map((row) => row.number === 330
      ? { ...row, hold: { reason: "Waiting on the shelf redesign", heldAt: NOW - 3_600_000 } } : row) })) };
    for (const html of [pane(true, held), pane(false, held)]) {
      const buttons = [...html.matchAll(/data-inventory-action="hold" aria-label="([^"]+)"[^>]*>([^<]+)</gu)].map((match) => [match[1], match[2]]);
      expect(buttons).toHaveLength(17);
      expect(buttons).toContainEqual(["Hold… folio #340", "Hold…"]);
      expect(buttons).toContainEqual(["Release folio #330", "Release"]);
    }
  });

  it("lets j and k focus rows for the deck's keys, with the same accent ring", () => {
    const html = pane(true);
    expect([...html.matchAll(/<tr data-inventory-row="[^"]+" data-depth="\d" tabindex="-1" class="([^"]+)"/gu)].every((match) => match[1]!.includes("focus-visible:ring-sky-500")))
      .toBe(true);
    expect(html.match(/tabindex="-1"/gu)!.length).toBeGreaterThanOrEqual(17);
  });
});

describe("the inventory before its first read", () => {
  it("keeps the view tabs while it reads or when the read failed, so every other view stays one click away", () => {
    const pending = (error: string | null) => renderToStaticMarkup(createElement(InventoryPending, { error, onRetry: noop, onView: noop, onHow: noop }));
    for (const html of [pending(null), pending("HTTP 500")]) {
      expect([...html.matchAll(/role="tab"[^>]*>([^<]+)</gu)].map((match) => match[1])).toEqual(["Efforts", "All PRs", "Map", "Pipeline", "Work", "Manage efforts"]);
      expect(text(html)).toContain("How it works");
    }
    expect(text(pending(null))).toContain("Reading your open PRs…");
    const failed = pending("HTTP 500");
    expect(failed).toContain('role="alert"');
    expect(failed).toMatch(/<button type="button" class="[^"]*focus-visible:ring-2[^"]*">Retry<\/button>/u);
    expect(text(failed)).toContain("Couldn't read the inventory: HTTP 500 Retry");
  });
});

describe("keyboard safety", () => {
  it("never merges on Enter: Enter on a row's Merge… only opens the fresh preview, whose Merge button refuses Enter and Space", () => {
    const url = "https://github.com/inkwell/folio/pull/340";
    const row = VIEW.groups.flatMap((group) => group.rows).find((item) => item.prUrl === url)!;
    // Enter or Space on a focused row button is a click, and a row's Merge… click only opens the preview: it carries no head to merge.
    expect(actionCall(row, line("folio #340").actions.find((item) => item.id === "merge")!)).toEqual({ kind: "preview", target: url });
    // In the preview, Enter or Space on Merge arrives as a click with detail 0 and is refused; only a pointer click or ⌘↵ merges.
    expect(mergeTrigger({ kind: "click", detail: 0 })).toBe("refuse");
    expect(mergeTrigger({ kind: "key", key: "Enter", metaKey: false, ctrlKey: false })).toBeNull();
    expect(mergeTrigger({ kind: "key", key: "Enter", metaKey: true, ctrlKey: false })).toBe("merge");
    // The preview names the inventory's unnumbered PR by repository and number, pinned to the head it read.
    const preview: MergePreview = { ok: true, live: { state: "OPEN", isDraft: false, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", headRefOid: row.head,
      stackedAbove: [], unresolvedThreads: 0, unresolvedAtLeast: false, approvalNotes: [], approvalNotesMore: 0, approvalNotesComplete: true },
      refusals: [], warnings: [], method: "squash", deleteBranch: true };
    const html = renderToStaticMarkup(createElement(MergePreviewBody, { items: [{ n: null, target: url, repo: "folio", number: 340, title: row.title, preview, result: null }],
      selected: new Set([url]), busy: false, notice: null, onToggle: noop, onMerge: noop, onCancel: noop, onOpenUrl: noop }));
    expect(text(html)).toContain(`folio #340 ${row.title} head ${row.head!.slice(0, 7)}`);
    expect(html).toMatch(/data-merge-go="true" title="Click, or press ⌘↵\. Merging needs ⌘↵ or a click; Enter alone doesn&#x27;t merge\."/u);
  });
});
