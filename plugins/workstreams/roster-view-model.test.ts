import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { effortRosterSchema, type EffortRoster } from "./effort-roster.js";
import { INKWELL_SHELVING_ROSTER as ROSTER, SHELVING_ROSTER_NOW as NOW } from "./inkwell-fixtures.js";
import { clock, nextWake, rosterView, settle, type RosterGroup, type RosterOrder } from "./roster-view-model.js";

const view = (order: RosterOrder = "number", roster: EffortRoster = ROSTER, settled = settle(roster)) =>
  rosterView(roster, { order, now: NOW, settled, seen: { seq: 400, at: NOW - (2 * 60 + 16) * 60_000 } });
const numbers = (group: RosterGroup) => group.lines.map((line) => `${line.branch ?? ""}${line.n}`);
const line = (n: number) => view().groups.flatMap((group) => group.lines).find((item) => item.n === n)!;
const withRow = (n: number, patch: Partial<EffortRoster["rows"][number]>): EffortRoster =>
  ({ ...ROSTER, rows: ROSTER.rows.map((row) => row.n === n ? { ...row, ...patch } : row) });

describe("roster view model", () => {
  it("reads the server's roster shape, so the fixture can't drift from what effort_roster_get returns", () => {
    expect(effortRosterSchema.parse(ROSTER)).toEqual(ROSTER);
  });

  it("lists open rows by number with each stack under its parent, then Done and Tickets without PRs collapsed", () => {
    const groups = view("number").groups;
    expect(groups.map((group) => [group.key, group.collapsed])).toEqual([["open", false], ["done", true], ["tickets", true]]);
    expect(numbers(groups[0]!)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "├10", "└11", "12", "13", "14", "15", "16", "17"]);
    expect(groups[1]!.summary).toBe("18 19 merged");
    expect(groups[2]!.summary).toBe("OPS-219 Shelf audit report");
    // Decision rows stay in the table: scanning for 14 finds it.
    expect(numbers(groups[0]!)).toEqual(expect.arrayContaining(["7", "12", "13", "14", "15"]));
  });

  it("groups by state in the hybrid's order, moving each stack with its parent's group", () => {
    const groups = view("state").groups;
    expect(groups.map((group) => group.label)).toEqual(["Needs a decision", "System issues", "Doing", "Waiting", "Ready", "Not in instruction", "Done", "Tickets without PRs"]);
    expect(Object.fromEntries(groups.map((group) => [group.label, numbers(group)]))).toMatchObject({
      "Needs a decision": ["7", "12", "13", "14", "15"],
      // 17 is Doing, recovering, but S1 names it, so it waits with the system issue.
      "System issues": ["17"],
      Doing: ["1", "2", "4"],
      Waiting: ["5", "6", "8"],
      Ready: ["9", "├10", "└11", "16"],
      "Not in instruction": ["3"],
    });
    expect(groups.filter((group) => group.collapsed).map((group) => group.label)).toEqual(["Not in instruction", "Done", "Tickets without PRs"]);
    expect(view("state").order).not.toContain(3);
  });

  it("keeps a row in its settled group while it changes, marks it changed, and moves it only on Mark seen", () => {
    const settled = settle(ROSTER);
    const ready = withRow(5, { state: "ready", cause: "merge-candidate", label: "Verified merge candidate", owner: "you", wake: null });
    const before = view("state", ready, settled);
    expect(numbers(before.groups.find((group) => group.key === "waiting")!)).toContain("5");
    expect(before.groups.flatMap((group) => group.lines).find((item) => item.n === 5)).toMatchObject({ changed: true, chip: { label: "you · merge" } });
    expect(before.since.settling).toBe(1);
    const after = view("state", ready, settle(ready));
    expect(numbers(after.groups.find((group) => group.key === "ready")!)).toContain("5");
    expect(after.since.settling).toBe(0);
    // By number never moves a row, but a merged row folds into Done only once you've seen it.
    const merged = withRow(5, { state: "done", cause: "merged", label: "Merged", owner: null });
    expect(numbers(view("number", merged, settled).groups[0]!)).toContain("5");
    expect(numbers(view("number", merged, settle(merged)).groups.find((group) => group.key === "done")!)).toContain("5");
  });

  it("gives each row the chip that names who acts next, from server fields only", () => {
    const chips = Object.fromEntries(view().groups.flatMap((group) => group.lines).map((item) => [item.n, item.chip.label]));
    expect(chips).toEqual({ 1: "thread", 2: "new worker", 3: "left alone", 4: "code", 5: "CI 7/9", 6: "@ines-v", 7: "D1", 8: "held 2d", 9: "you · merge",
      10: "↱ 9", 11: "↱ 9", 12: "D1", 13: "D2", 14: "D2", 15: "D2", 16: "you · merge", 17: "launch?", 18: "merged", 19: "merged" });
    expect(line(2).chip).toMatchObject({ kind: "new-worker", title: "the only quill thread is busy on #185", threadId: "thr_quill_188" });
    expect(line(2).next.lead).toBe("the only quill thread is busy on #185");
    expect(line(5).chip.progress).toEqual({ done: 7, total: 9, failed: 0 });
    // Only decisions are amber and only system issues rose.
    expect(view().groups.flatMap((group) => group.lines).filter((item) => item.chip.tone).map((item) => [item.n, item.chip.tone]))
      .toEqual([[7, "decision"], [12, "decision"], [13, "decision"], [14, "decision"], [15, "decision"]]);
  });

  it("shows how long a hold has stood and how old a stale observation is", () => {
    expect(line(8)).toMatchObject({ held: true, chip: { kind: "held", label: "held 2d" }, next: { lead: "held by you 2d: \"waiting on catalog team copy\" · release 8 to include" } });
    expect(line(6).seen).toEqual({ age: "52m", stale: true, failed: false });
    expect(line(5).seen).toEqual({ age: "2m", stale: false, failed: false });
    const failed = rosterView(withRow(5, { failedAt: NOW - 30_000 }), { order: "number", now: NOW, settled: settle(ROSTER), seen: null });
    expect(failed.groups[0]!.lines.find((item) => item.n === 5)!.seen.failed).toBe(true);
  });

  it("says releasing a hold includes the row only when the instruction does, so the held chip can't hide that it's left alone", () => {
    const heldIn = (membership: EffortRoster["rows"][number]["membership"]) => rosterView(withRow(3, { membership, hold: { reason: "legal review", heldAt: NOW - 60 * 60_000 } }),
      { order: "number", now: NOW, settled: settle(ROSTER), seen: null }).groups.flatMap((group) => group.lines).find((item) => item.n === 3)!;
    const alone = heldIn("excluded");
    expect(alone).toMatchObject({ leftAlone: true, chip: { kind: "held" }, next: { lead: "held by you 1h: \"legal review\" · also left alone this instruction" } });
    expect(alone.chip.title).toBe("Held by you: legal review. A hold outlasts every instruction; also left alone this instruction.");
    expect(heldIn("included").next.lead).toBe("held by you 1h: \"legal review\" · release 3 to include");
    // Outside the instruction, releasing includes nothing, so nothing says it would.
    for (const membership of ["outside", "removed", null] as const) {
      expect(heldIn(membership).next.lead, String(membership)).toBe("held by you 1h: \"legal review\"");
      expect(heldIn(membership).chip.title, String(membership)).not.toContain("include");
    }
  });

  it("keeps recovering and draining in the state label you read, leaving plan only to its chip", () => {
    expect(line(17).state).toEqual({ label: "Doing, recovering", short: "Doing, recovering", tone: null });
    expect(line(3).state.short).toBe("Not in instr.");
    const planned = rosterView(withRow(5, { modifiers: ["draining", "plan only"] }), { order: "number", now: NOW, settled: settle(ROSTER), seen: null })
      .groups[0]!.lines.find((item) => item.n === 5)!;
    expect(planned.state).toMatchObject({ label: "Waiting, draining", short: "Waiting, draining" });
  });

  it("draws one ribbon cell per number, hatched when held, outlined when left alone, and dotted when stale", () => {
    const { ribbon, legend } = view();
    expect(ribbon.map((cell) => cell.n)).toEqual(Array.from({ length: 19 }, (_, index) => index + 1));
    expect(ribbon.filter((cell) => cell.held).map((cell) => cell.n)).toEqual([8]);
    expect(ribbon.filter((cell) => cell.stale).map((cell) => cell.n)).toEqual([6]);
    expect(ribbon.filter((cell) => cell.leftAlone).map((cell) => cell.n)).toEqual([3]);
    expect(ribbon.find((cell) => cell.n === 17)!.group).toBe("issue");
    expect(legend).toEqual({ decide: 5, system: 1, ready: 2 });
  });

  it("heads the pane with the instruction's scope and says what changed since you looked", () => {
    const { header, since, rollup } = view();
    expect(header).toEqual({ name: "Shelving entry", instruction: "rev 4 · includes 1, 2, 4-17 · not 3 · 8 held", snapshot: "S-41a7c3e90b2d", execution: null, note: null });
    expect(since.parts.map((part) => `${part.chips.map((chip) => chip.label).join(" ")} ${part.text}`))
      .toEqual(["9 16 → Ready", "18 merged", "D1 D2 S1 new", "4 new head"]);
    expect(since.handled).toBe(9);
    expect(line(4).changed).toBe(true);
    expect(line(1).changed).toBe(false);
    expect(rollup.map((item) => [item.label, item.tone])).toEqual([["Outcome", null], ["Validated", null], ["Still needed", null], ["Needs a decision", "decision"]]);
    expect(rollup[0]!.text).toMatch(/^Staff shelve new stock/u);
    expect(view("number", { ...ROSTER, execution: { mode: "legacy", revision: 0 } }).header.execution).toBe("legacy launchers · read only");
    expect(view("number", { ...ROSTER, v2Execution: "dry-run" }).header.execution).toBe("dry run · plans only");
  });

  it("names the next wake by the reconciler's due time, never a guessed duration", () => {
    const quiet: EffortRoster = { ...ROSTER, decisions: [], issues: [],
      rows: ROSTER.rows.filter((row) => ["doing", "waiting", "done", "not-in-instruction"].includes(row.state)) };
    const due = ROSTER.rows.find((row) => row.n === 5)!.wake!.dueAt;
    expect(nextWake(quiet, NOW)).toBe(`Nothing needs you · next wake: CI on 5 · looks again ${clock(due, NOW)} · then review from @ines-v on 6`);
    expect(view("number", quiet).empty).toBe(nextWake(quiet, NOW));
    // The order is the server's due times: move CI's later and the review wakes first.
    const later = { ...quiet, rows: quiet.rows.map((row) => row.n === 5 ? { ...row, wake: { event: "check results change", dueAt: due + 60 * 60_000 } } : row) };
    expect(nextWake(later, NOW)).toMatch(/^Nothing needs you · next wake: review from @ines-v on 6 · looks again \S+ · then 9 merging on 10$/u);
    expect(nextWake({ ...quiet, rows: [...quiet.rows, ROSTER.rows.find((row) => row.n === 9)!] }, NOW)).toMatch(/^No asks · 1 ready to merge · next wake: /u);
    expect(nextWake(quiet, NOW)).not.toMatch(/~|\bmin\b/u);
    // An open decision or system issue is an ask, so there's no empty state.
    expect(view().empty).toBeNull();
  });

  it("offers every row command with its text and key, and says why a disabled one can't run", () => {
    const menu = (n: number, roster: EffortRoster = ROSTER) => rosterView(roster, { order: "number", now: NOW, settled: settle(roster), seen: null })
      .groups.flatMap((group) => group.lines).find((item) => item.n === n)!.menu;
    expect(menu(17).map((item) => [item.label, item.command, item.key, item.enabled])).toEqual([
      ["Refresh", "refresh 17", "r", true], ["Recheck", "recheck 17", "c", true], ["Reset…", "reset 17 release", "⇧R", true], ["Hold…", "hold 17 because …", "h", true],
      ["Retry", "retry 17", "t", false], ["Stop", "stop 17", "⇧S", false], ["Open thread", null, "⏎", true], ["Open PR", null, "o", true]]);
    // Dropping an uncertain launch's claim needs you to confirm no worker is writing.
    expect(menu(17).find((item) => item.id === "reset")).toMatchObject({ confirm: true });
    expect(menu(17).find((item) => item.id === "retry")!.why).toBe("Uncertain launch: a retry could start a second writer");
    expect(menu(8).find((item) => item.id === "release")).toMatchObject({ command: "release 8", enabled: true });
    expect(menu(18).find((item) => item.id === "hold")).toMatchObject({ enabled: false, why: "Done rows can't be held" });
    expect(menu(3).find((item) => item.id === "thread")).toMatchObject({ enabled: false, why: "No thread yet" });
    // A legacy effort takes no command, so only Refresh and the two opens stay live.
    const legacy = menu(17, { ...ROSTER, execution: { mode: "legacy", revision: 0 } });
    expect(legacy.filter((item) => item.enabled).map((item) => item.id)).toEqual(["refresh", "thread", "pr"]);
    expect(new Set(legacy.filter((item) => !item.enabled).map((item) => item.why))).toEqual(new Set(["Runs on legacy launchers; move it to its roster first"]));
  });

  it("imports only types and roster-shared, so it can't compute readiness or reach a server module", () => {
    const source = readFileSync(new URL("./roster-view-model.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import (type )?.* from "(.+)";$/gmu)].map((match) => [match[2], match[1] === "type " ? "type" : "value"]);
    expect(imports).toEqual([["./effort-roster", "type"], ["./roster-shared", "value"]]);
  });
});
