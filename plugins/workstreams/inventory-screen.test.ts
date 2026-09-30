import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { inkwellInventory, INVENTORY_NOW as NOW } from "./inkwell-fixtures.js";
import type { InventoryView } from "./inventory-view.js";
import { actionCall, inventoryScreen, type InventoryLine } from "./inventory-view-model.js";
import { InventoryPane, InventoryPending, splitInventory } from "./inventory-screen.js";
import { feedbackItems, type FeedbackItem } from "./review-feedback-queue.js";
import { MergePreviewBody, mergeTrigger, type MergePreview } from "./roster-merge-dialog.js";

const VIEW = inkwellInventory();
const SCREEN = inventoryScreen(VIEW, { now: NOW, filter: null });
const noop = () => {};
const item = (repo: string, number: number, state = "queued", rule = "feedback-to-address"): FeedbackItem => ({
  key: `${repo}#${number}`, repo, number, state, rule, title: `Feedback on ${number}`, url: `https://github.com/${repo}/pull/${number}`,
  reason: "Changes requested", updatedAt: new Date(NOW - 3_600_000).toISOString(),
});
const feedback = [item("inkwell/folio", 330), item("inkwell/catalog", 96), item("inkwell/new-repo", 44)];
function pane(items: FeedbackItem[] | null = feedback, error: string | null = null, view: InventoryView = VIEW) {
  return renderToStaticMarkup(createElement(InventoryPane, { screen: view === VIEW ? SCREEN : inventoryScreen(view, { now: NOW, filter: null }), feedback: items,
    feedbackError: error, startError: null, busyKey: null, error: null, onView: noop, onHow: noop, onOpenPr: noop, onOpenThread: noop, onOpenRoster: noop, onStart: noop,
    onNudge: noop }));
}
const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/&quot;/gu, '"').replace(/&#x27;/gu, "'").replace(/&amp;/gu, "&").replace(/\s+/gu, " ");
const line = (pr: string): InventoryLine => SCREEN.groups.flatMap((group) => group.lines).find((item) => `${item.repo} #${item.number}` === pr)!;
/** One row's markup, from its start to the next row's. */
const rowOf = (html: string, ref: string) => { const start = html.indexOf(`data-inventory-row="${ref}"`); return html.slice(start, html.indexOf("data-inventory-row=", start + 20)); };

describe("simple All PRs list", () => {
  it("puts queued feedback first by effort, with unmatched feedback under No effort and no duplicate PR rows", () => {
    const parts = splitInventory(SCREEN, feedback);
    expect(parts.feedback.map((group) => group.label)).toEqual(["Shelf order", "No effort"]);
    expect(parts.feedback.flatMap((group) => group.rows).map(({ item }) => `${item!.repo}#${item!.number}`))
      .toEqual(["inkwell/folio#330", "inkwell/catalog#96", "inkwell/new-repo#44"]);
    expect(parts.other.flatMap((group) => group.rows).some(({ line }) => line?.number === 330 || line?.number === 96)).toBe(false);
    const html = pane();
    expect(html).toContain("Back to me");
    expect(html).toContain("Other open PRs");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("Filter by question");
  });

  it("filters out nonqueued or nonfeedback Reviews items", () => {
    expect(feedbackItems([item("inkwell/folio", 330, "started"), item("inkwell/folio", 330, "queued", "review-requested"),
      item("inkwell/folio", 330), item("inkwell/folio", 330)])).toHaveLength(1);
  });

  it("offers Nudge only where the inventory action is enabled", () => {
    const html = pane([]);
    expect((html.match(/data-inventory-action="nudge"/gu) ?? [])).toHaveLength(1);
    expect(html).not.toContain("data-inventory-action=\"merge\"");
    expect(html).not.toContain("data-inventory-action=\"request-review\"");
  });

  it("keeps other PRs visible and names a Reviews failure without claiming zero feedback", () => {
    const pending = pane(null, "Unavailable");
    expect(pending).toContain("Reviews queue unavailable: Unavailable");
    expect(pending).toContain("Back to me");
    expect(pending).toContain('data-inventory-row="inkwell/folio#330"');
    expect(pending).toContain("Feedback is unavailable right now.");
    expect(pending).not.toContain("Reading feedback from Reviews…");
  });

  it("keeps the primary read notice visible and folds many other notices without dropping their text or roles", () => {
    const notices = [{ tone: "error" as const, text: "GitHub rate limited this read." },
      ...Array.from({ length: 24 }, (_, index) => ({ tone: "info" as const, text: `Repository ${index + 1} needs a read.` }))];
    const html = renderToStaticMarkup(createElement(InventoryPane, { screen: { ...SCREEN, notices }, feedback: [], feedbackError: null,
      startError: null, busyKey: null, error: "Inventory request failed", onView: noop, onHow: noop, onOpenPr: noop,
      onOpenThread: noop, onOpenRoster: noop, onStart: noop, onNudge: noop }));
    expect(html).toMatch(/role="alert"[^>]*>Couldn&#x27;t read the inventory: Inventory request failed/gu);
    expect(html).toMatch(/role="alert"[^>]*>GitHub rate limited this read\.<\/p><details/gu);
    expect(html).toContain("<summary");
    expect(html).toContain("24 more inventory notices");
    expect(html).not.toContain("<details open");
    expect(html).toContain("Repository 24 needs a read.");
    expect(html.indexOf("</details>")).toBeLessThan(html.indexOf("Back to me"));
  });

  it("keeps tabs and retry visible when the first inventory read fails", () => {
    const html = renderToStaticMarkup(createElement(InventoryPending, { error: "HTTP 500", onRetry: noop, onView: noop, onHow: noop }));
    expect(html).toContain("All PRs");
    expect(html).toContain("Couldn&#x27;t read the inventory: HTTP 500");
    expect(html).toContain("Retry");
  });

  it("links each effort's group to its roster, with No effort last and plain", () => {
    const html = pane([]);
    const heading = (label: string) => html.slice(html.indexOf(`data-inventory-group="${label}"`), html.indexOf("</h3>", html.indexOf(`data-inventory-group="${label}"`)));
    expect(heading("Shelf order")).toMatch(/<button type="button"[^>]*>Shelf order<\/button>$/u);
    expect(heading("Store pickup")).toMatch(/<button type="button"[^>]*>Store pickup<\/button>$/u);
    expect(html.indexOf('data-inventory-group="No effort"')).toBeGreaterThan(html.indexOf('data-inventory-group="Store pickup"'));
    expect(heading("No effort")).not.toContain("<button");
  });

  it("shows each row's state word and next step with its age", () => {
    const words = text(pane([]));
    expect(words).toContain("inkwell/catalog #96 ABC-121 Show series order on catalog pages Awaiting review · Nudge @mira-l, @theo-k · 2d Nudge");
    expect(words).toContain("inkwell/folio #330 ABC-364 Keep shelf filters in the link Conflicts · Resolve the conflicts · 2d+");
    expect(words).toContain("inkwell/quill #212 ABC-372 Email when a hold is ready Behind #210 · Waits on #210");
  });

  // Confirming review notes is the deck's: one PR's notes, read fresh, in its confirm. All PRs shows the wait and offers no way around it.
  it("shows an approval with comments to confirm as its state and next step, with no Confirm handled or Merge… here", () => {
    for (const ref of ["inkwell/folio#301", "inkwell/folio#318"]) {
      const row = rowOf(pane([]), ref);
      expect(text(row)).toContain("Approved with comments · Confirm the approval's comments are handled · 2d");
      expect(row).not.toContain('data-inventory-action="confirm-handled"');
      expect(row).not.toContain('data-inventory-action="merge"');
    }
  });

  it("keeps every row's PR number outside the part that truncates, so a long repo name never hides it", () => {
    const long = "inkwell/a-repository-name-long-enough-to-truncate-in-any-pane";
    const html = pane([item(long, 44)]);
    const numbers = [...html.matchAll(/<span class="min-w-0 truncate">([^<]*)<\/span><span class="shrink-0">#(\d+)<\/span>/gu)];
    expect(numbers).toHaveLength(18);
    for (const [, repo] of numbers) expect(repo).not.toMatch(/#\d/u);
    expect(numbers.map((match) => `${match[1]}#${match[2]}`)).toContain(`${long}#44`);
  });

  it("shows a row's last action, or the server's refusal word for word, under its next step", () => {
    const refused = "Who needs a nudge changed since the row was shown (now @mira-l). Review it and try again; nothing was written.";
    const view = { ...VIEW, groups: VIEW.groups.map((group) => ({ ...group, rows: group.rows.map((row) => row.number === 96
      ? { ...row, lastAction: { at: NOW - 60_000, action: "nudge" as const, ok: false, detail: refused, reviewers: [] } } : row) })) };
    expect(pane([], null, view)).toMatch(new RegExp(`<p role="status" class="[^"]*text-destructive"[^>]*>Nudge refused 1m ago: ${refused.replace(/[().]/gu, "\\$&")}</p>`, "u"));
  });

  it("shows the rate limit and a failed read as alerts naming the reset", () => {
    const html = pane([], null, { ...VIEW, rateLimitedUntil: NOW + 5 * 60_000 });
    expect(html).toMatch(/role="alert"[^>]*>.*?GitHub&#x27;s rate limit holds reads until \d{2}:\d{2}\. Rows show the last good read\./u);
    const failed = renderToStaticMarkup(createElement(InventoryPane, { screen: SCREEN, feedback: [], feedbackError: null, startError: null, busyKey: null,
      error: "HTTP 500", onView: noop, onHow: noop, onOpenPr: noop, onOpenThread: noop, onOpenRoster: noop, onStart: noop, onNudge: noop }));
    expect(failed).toContain('role="alert" class="text-[12px] text-destructive">Couldn&#x27;t read the inventory: HTTP 500');
  });

  it("keeps every text size at 11px or larger, uses no amber, and animates only when motion is allowed", () => {
    const busy = { ...VIEW, refreshing: true };
    for (const html of [pane(), pane([]), pane(null, "Unavailable"), pane([], null, busy)]) {
      expect(html).not.toMatch(/text-\[(?:[0-9]|10)(?:\.\d+)?px\]|text-\[0\.\d+rem\]|text-xs/u);
      expect(html).not.toMatch(/\bamber-/u);
      expect(html).not.toMatch(/(?<!motion-safe:)\banimate-/u);
      expect(html).not.toMatch(/#[0-9a-f]{6}\b/iu);
    }
    expect(pane([], null, busy)).toContain("motion-safe:animate-spin");
  });
});

describe("All PRs beside the effort deck", () => {
  // Holding an effort holds its PRs, so a Nudge there would only be refused; a done or archived effort's rows offer none either.
  it("offers no Nudge on a held, done, or archived effort's rows, and keeps the rows in view", () => {
    const piled = (pile: "held" | "done" | "archived"): InventoryView => ({ ...VIEW, groups: VIEW.groups.map((group) => group.effort === null
      ? { ...group, effort: { id: "effort-loose", name: "Loose ends", pile } } : group) });
    expect(rowOf(pane([]), "inkwell/catalog#96")).toContain('data-inventory-action="nudge"');
    for (const pile of ["held", "done", "archived"] as const) {
      const html = pane([], null, piled(pile));
      expect(html).not.toContain('data-inventory-action="nudge"');
      expect(html).toContain('data-inventory-row="inkwell/catalog#96"');
    }
  });

  // A per-PR hold suppresses every step the row would name, so its Nudge goes too, until you release it in the deck.
  it("offers no Nudge on a held PR", () => {
    const held: InventoryView = { ...VIEW, groups: VIEW.groups.map((group) => ({ ...group, rows: group.rows.map((row) => row.number === 96
      ? { ...row, hold: { reason: "Waiting on the catalog redesign", heldAt: NOW - 3_600_000 }, attention: [], status: "On hold" } : row) })) };
    const row = rowOf(pane([], null, held), "inkwell/catalog#96");
    expect(text(row)).toContain("On hold");
    expect(row).not.toContain('data-inventory-action="nudge"');
  });

  it("lets j and k focus rows for the deck's keys, with the same accent ring", () => {
    const html = pane();
    const rows = [...html.matchAll(/<li data-inventory-row="[^"]+" tabindex="-1" class="([^"]+)"/gu)];
    expect(rows).toHaveLength(18);
    expect(rows.every((match) => match[1]!.includes("focus-visible:ring-sky-500"))).toBe(true);
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
  // All PRs offers no merge at all; the deck's Merge… opens the same fresh preview, whose Merge button refuses Enter and Space.
  it("never merges from All PRs, and a row's merge only opens the fresh preview, whose Merge refuses Enter", () => {
    for (const html of [pane(), pane([]), pane(null, "Unavailable")]) {
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
