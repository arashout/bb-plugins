import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { interpretEffortCommand, type CommandContext } from "./effort-command";
import type { EffortRoster } from "./effort-roster";
import { INKWELL_SHELVING_ROSTER as ROSTER, SHELVING_ROSTER_NOW as NOW } from "./inkwell-fixtures";
import { ackView, holdCommand, rosterKey, rosterView, rowCommandInput, rowIntent, settle } from "./roster-view-model";
import type { CommandBoxProps } from "./roster-command";
import { keyRow, RosterPane, RosterPicker, typing } from "./roster-view";

const noop = () => {};
const box = (command: Partial<CommandBoxProps> = {}): CommandBoxProps =>
  ({ value: "", onValue: noop, onSubmit: noop, ack: null, open: false, onToggle: noop, onLeave: noop, note: null, ...command });
function pane(wide: boolean, roster: EffortRoster = ROSTER, order: "number" | "state" = "number", command: Partial<CommandBoxProps> = {}) {
  const view = rosterView(roster, { order, now: NOW, settled: settle(roster), seen: { seq: 400, at: NOW - 60 * 60_000 } });
  return renderToStaticMarkup(createElement(RosterPane, {
    view, wide, mount: "tab", live: true, order, focusN: null, menuN: null, liveThreads: new Set(["thr_folio_entry"]), command: box(command), history: roster.history,
    hasParent: true, onOrder: noop, onMarkSeen: noop, onHeader: noop, onFocus: noop, onCompose: noop, onMenu: noop, onAction: noop, onToggleGroup: noop, onOpenUrl: noop,
  }));
}
const headers = (html: string) => [...html.matchAll(/<th[^>]*>(.*?)<\/th>/gu)].map((match) => match[1]!.replace(/<[^>]+>/gu, ""));
/** Every opening tag whose class names a color. */
const tagsWith = (html: string, color: string) => [...html.matchAll(new RegExp(`<[^>]*class="[^"]*\\b[a-z:-]*${color}-[^"]*"[^>]*>`, "gu"))].map((match) => match[0]);

describe("roster pane markup", () => {
  it("draws the column table at 900px and up, and two-line rows below it", () => {
    const wide = pane(true);
    expect(wide).toContain("<table");
    expect(headers(wide).slice(0, 8)).toEqual(["#", "PR", "Reviewer", "Summary", "State", "Owner · wake · next", "Seen", "Actions"]);
    const narrow = pane(false);
    expect(narrow).not.toContain("<table");
    expect(narrow).toContain('role="list"');
  });

  it("gives every row a visible menu named for the row", () => {
    for (const html of [pane(true), pane(false)]) {
      expect(html).toContain('aria-label="Actions for 17 · folio #421"');
      const open = ROSTER.rows.filter((row) => row.state !== "done");
      expect(html.match(/aria-label="Actions for /gu)).toHaveLength(open.length);
    }
  });

  it("makes each row's number compose it into the command box, pinned below the rows, without running anything", () => {
    for (const html of [pane(true), pane(false)]) {
      expect(html.match(/data-compose="\d+"/gu)).toHaveLength(ROSTER.rows.filter((row) => row.state !== "done").length);
      expect(html).toContain('title="Add 4 to the command; Shift-click for a range"');
      expect(html.indexOf('aria-label="Command"')).toBeGreaterThan(html.lastIndexOf("data-compose="));
    }
  });

  it("keeps every text size at 11px or larger", () => {
    const ack = ackView({ ...ROSTER.lastCommand!, fresh: true }, NOW);
    for (const html of [pane(true), pane(false), pane(true, ROSTER, "state"), pane(true, ROSTER, "number", { ack, open: true })])
      expect(html).not.toMatch(/text-\[(?:[0-9]|10)(?:\.\d+)?px\]/u);
  });

  it("uses amber only on decisions and stale marks, and rose only on system issues", () => {
    for (const html of [pane(true), pane(false), pane(true, ROSTER, "state")]) {
      const amber = tagsWith(html, "amber");
      const rose = tagsWith(html, "rose");
      expect(amber.length).toBeGreaterThan(0);
      expect(rose.length).toBeGreaterThan(0);
      expect(amber.filter((tag) => !/data-tone="(decision|stale)"/u.test(tag))).toEqual([]);
      expect(rose.filter((tag) => !/data-tone="issue"/u.test(tag))).toEqual([]);
    }
  });

  it("shows a row's recovering or draining in its state cell, not only on hover", () => {
    const text = (html: string) => html.replace(/<[^>]+>/gu, "\n");
    for (const html of [pane(true), pane(false)]) expect(text(html).split("\n")).toContain("Doing, recovering");
  });

  it("says nothing needs you, and names the next wake, once no decision or system issue is open", () => {
    expect(pane(true)).not.toContain("Nothing needs you");
    const quiet: EffortRoster = { ...ROSTER, decisions: [], issues: [], rows: ROSTER.rows.filter((row) => !["decision", "ready"].includes(row.state)) };
    expect(pane(true, quiet)).toContain("Nothing needs you · next wake: CI on 5");
  });

  it("shows the since-line with the steps v2 handled, and the held and stale ages", () => {
    const html = pane(true);
    expect(html).toContain("9 steps handled without you");
    expect(html).toContain("Mark seen");
    expect(html).toContain("held 2d");
    expect(html).toMatch(/aria-label="Stale"[^>]*><\/span>52m/u);
  });

  it("lists rosters that run on v2 before legacy ones, leaving archived efforts out", () => {
    const html = renderToStaticMarkup(createElement(RosterPicker, { onPick: noop, efforts: [
      { id: "a", key: "a", name: "Atlas cleanup", archived: false, mode: "legacy", parentThreadId: null },
      { id: "s", key: "s", name: "Shelving entry", archived: false, mode: "v2", parentThreadId: "thr_shelving_parent" },
      { id: "v", key: "v", name: "Vault audits", archived: true, mode: "v2", parentThreadId: null },
    ] }));
    expect([...html.matchAll(/truncate text-\[13px\]">([^<]+)</gu)].map((match) => match[1])).toEqual(["Shelving entry", "Atlas cleanup"]);
  });
});

describe("roster pane commands and keys", () => {
  const lines = rosterView(ROSTER, { order: "number", now: NOW, settled: settle(ROSTER), seen: null }).groups.flatMap((group) => group.lines);
  const at = (n: number) => lines.find((line) => line.n === n)!;
  /** The parser the server runs, over the fixture's numbers and its open D1 and D2. */
  const context: CommandContext = {
    effortId: ROSTER.effort.id, snapshot: { id: ROSTER.snapshotId!, effortId: ROSTER.effort.id, stale: false, rows: ROSTER.rows.map(({ n, target }) => ({ n, target })) },
    issued: new Map(ROSTER.rows.map((row) => [row.n, row.target])), rows: new Map(), holds: {}, instruction: null, lastRevision: 4,
    decisions: ROSTER.decisions.map((decision) => ({ n: decision.n, options: decision.options.map((option) => option.id), targets: decision.targets.flatMap((target) => target.n ?? []) })),
    ownerOf: () => ({ effortId: ROSTER.effort.id, name: ROSTER.effort.name }),
  };

  it("keeps a hold reason one hold's words, so Hold can't grant work, answer a decision, or release a row", () => {
    for (const reason of ["waiting on copy, then move 5 forward", "copy pending. D1 A", "waiting on copy; release 8", "flaky, recheck 5", "waiting on design\nreset 17 release",
      "waiting on design; release after launch"]) {
      const command = holdCommand(4, reason);
      const result = interpretEffortCommand(command, context);
      if (result.kind !== "admit") throw new Error(`${JSON.stringify(reason)} asked: ${result.message}`);
      expect(result.holds, reason).toEqual([{ target: at(4).target, n: 4, reason: command.slice("hold 4 because ".length) }]);
      expect({ ...result, holds: [], normalized: "", acknowledgment: [], parts: null }, reason).toEqual({ kind: "admit", normalized: "", acknowledgment: [], parts: null,
        instruction: null, cancel: false, holds: [], releases: [], interventions: [], recheckLaunches: false, postRoster: false, mergePreviews: [], answers: [] });
    }
    expect(holdCommand(4, " waiting on copy, legal review. ")).toBe("hold 4 because waiting on copy legal review");
    expect(holdCommand(4, " ;. ")).toBe("hold 4");
    // A period inside a word or a number doesn't end a sentence, so it stays.
    expect(holdCommand(4, "after v2.1 ships")).toBe("hold 4 because after v2.1 ships");
  });

  it("sends a row command without the decisions the pane shows, so the server refuses any Dn in it", () => {
    expect(rowCommandInput(ROSTER, "recheck 17", "req-1")).toEqual({ effortId: ROSTER.effort.id, snapshotId: ROSTER.snapshotId, text: "recheck 17", requestId: "req-1",
      source: "panel", expectedRevision: 4 });
  });

  it("resets an uncertain launch only from its confirm, and asks Hold's reason before sending", () => {
    expect(rowIntent(at(17), "reset")).toEqual({ kind: "confirm-reset" });
    const sends = lines.flatMap((line) => line.menu.map((item) => rowIntent(line, item.id))).flatMap((intent) => intent?.kind === "send" ? [intent.command] : []);
    expect(sends).toContain("reset 5");
    expect(sends.filter((command) => /^reset \d+ release$/u.test(command))).toEqual([]);
    expect(rowIntent(at(5), "hold")).toEqual({ kind: "hold" });
    expect(rowIntent(at(8), "release")).toEqual({ kind: "send", command: "release 8" });
    expect(rowIntent(at(17), "retry")).toEqual({ kind: "refuse", command: "retry 17", why: "Uncertain launch: a retry could start a second writer" });
    expect(rowIntent(at(17), "refresh")).toEqual({ kind: "refresh", command: "refresh 17" });
  });

  it("reads ⇧R and ⇧S from Shift, never the letter's case, so Caps Lock can't turn Refresh into Reset or the order toggle into Stop", () => {
    const press = (key: string, shiftKey = false, on = { control: false, held: false }) => rosterKey({ key, shiftKey, metaKey: false, ctrlKey: false, altKey: false }, on);
    // Caps Lock on: the browser reports "R" and "S" without Shift.
    expect(press("R")).toEqual({ kind: "row", id: "refresh" });
    expect(press("S")).toEqual({ kind: "order" });
    expect(press("R", true)).toEqual({ kind: "row", id: "reset" });
    expect(press("S", true)).toEqual({ kind: "row", id: "stop" });
    // Caps Lock with Shift reports the lowercase letter.
    expect(press("r", true)).toEqual({ kind: "row", id: "reset" });
    expect(press("s", true)).toEqual({ kind: "row", id: "stop" });
    expect(press("h", false, { control: false, held: true })).toEqual({ kind: "row", id: "release" });
    // Space and Enter on a button or link belong to that control, and a chord belongs to the host.
    expect(press(" ", false, { control: true, held: false })).toBeNull();
    expect(press("Enter", false, { control: true, held: false })).toBeNull();
    expect(press("Enter")).toEqual({ kind: "row", id: "thread" });
    expect(rosterKey({ key: "r", shiftKey: false, metaKey: true, ctrlKey: false, altKey: false }, { control: false, held: false })).toBeNull();
  });

  it("acts on the row keyboard focus is in, not the one highlighted before you opened another row's menu", () => {
    const inRow = (n: number) => ({ closest: (selector: string) => selector === "[data-roster-row]" ? { getAttribute: () => String(n) } : null }) as unknown as EventTarget;
    expect(keyRow(inRow(9), 5)).toBe(9);
    expect(keyRow({ closest: () => null } as unknown as EventTarget, 5)).toBe(5);
    expect(keyRow(null, null)).toBeNull();
  });

  it("pauses its keys while you type in a field, a dialog, or a menu", () => {
    const within = (place: string) => ({ closest: (list: string) => list.split(",").map((part) => part.trim()).includes(place) ? {} : null }) as unknown as EventTarget;
    for (const place of ["input", "textarea", "select", "[contenteditable]", "[role=dialog]", "[role=menu]"]) expect(typing(within(place)), place).toBe(true);
    expect(typing({ isContentEditable: true, closest: () => null } as unknown as EventTarget)).toBe(true);
    expect(typing(within("[data-roster-row]"))).toBe(false);
    expect(typing(null)).toBe(false);
  });
});
