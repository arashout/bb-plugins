import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { interpretEffortCommand, type CommandContext } from "./effort-command.js";
import { effortRosterSchema, type EffortRoster } from "./effort-roster.js";
import { INKWELL_SHELVING_ROSTER as ROSTER, SHELVING_ROSTER_NOW as NOW } from "./inkwell-fixtures.js";
import { ANSWER_DELAY } from "./effort-v2-server.js";
import { ackChips, ackDetails, ackRows, ackView, answerCommand, answerInput, answerKey, askCards, clock, commandInput, composeNumber, fieldAnswerInput, firstAsk, latestUndo, nextWake,
  afterAnswer, paneKey, recoveryIntent, rosterKey, rosterView, settle, shownCommand, UNDO_WINDOW, type AckParts, type CommandRecord, type DecisionAsk, type IssueAsk, type KeyEvent, type PaneEffect, type PaneState, type RosterGroup,
  type RosterOrder } from "./roster-view-model.js";

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

describe("roster command box", () => {
  const target = (n: number) => ROSTER.rows.find((row) => row.n === n)!.target;
  /** The parser the server runs over the fixture's numbers, with revision 3 including 1, 2, and 7-17, and 8 held. */
  function parse(text: string, holds: number[] = [8]) {
    const base: CommandContext = {
      effortId: ROSTER.effort.id, snapshot: { id: ROSTER.snapshotId!, effortId: ROSTER.effort.id, stale: false, rows: ROSTER.rows.map(({ n, target: url }) => ({ n, target: url })) },
      issued: new Map(ROSTER.rows.map((row) => [row.n, row.target])), rows: new Map(), holds: {}, instruction: null, lastRevision: 0, decisions: [],
      ownerOf: () => ({ effortId: ROSTER.effort.id, name: ROSTER.effort.name }),
    };
    const rev = interpretEffortCommand("move 1, 2, 7-17 forward", base);
    if (rev.kind !== "admit") throw new Error(rev.message);
    const result = interpretEffortCommand(text, { ...base, instruction: rev.instruction, lastRevision: rev.instruction!.revision,
      holds: Object.fromEntries(holds.map((n) => [target(n), { reason: "waiting on catalog team copy", heldAt: NOW }])) });
    if (result.kind !== "admit") throw new Error(result.message);
    return { ...result.parts, answers: [], starting: [] } satisfies AckParts;
  }
  const labels = (parts: AckParts) => ackChips(parts).map((chip) => chip.label);

  it("sends the snapshot it rendered, the revision it showed, and each decision at the revision you read, so an answer can't reach a changed question", () => {
    expect(commandInput(ROSTER, "D1 A", "req-2")).toEqual({ effortId: ROSTER.effort.id, snapshotId: ROSTER.snapshotId, text: "D1 A", requestId: "req-2", source: "panel",
      expectedRevision: 4, decisions: [{ n: 1, revision: 1 }, { n: 2, revision: 1 }] });
    const changed = { ...ROSTER, decisions: ROSTER.decisions.map((decision) => decision.n === 1 ? { ...decision, revision: 3 } : decision) };
    expect(commandInput(changed, "D1 A", "req-3").decisions).toEqual([{ n: 1, revision: 3 }, { n: 2, revision: 1 }]);
  });

  it("names the parser's parts in the chip row, held rows included and no merge last, so leaving a row alone never reads as holding it", () => {
    expect(labels(parse("move 1-6 forward, leave 3 alone"))).toEqual(["+4-6 added", "1, 2 kept", "3 left alone, not a hold", "8 held, hold wins", "no merge"]);
    // A hold you set a moment ago still shows when the next command names the row (A8).
    expect(labels(parse("move 1..6 forward except 3", [5, 8]))).toEqual(["+4-6 added", "1, 2 kept", "3 left alone, not a hold", "5, 8 held, hold wins", "no merge"]);
    // Even a command about another row names the held one.
    expect(labels(parse("release 4"))).toContain("8 held, hold wins");
    expect(labels(parse("hold 6 because waiting on copy"))).toEqual(["6 now held", "8 held, hold wins", "no merge"]);
  });

  it("labels the details block the way the thread's acknowledgment reads, and keeps any finding the parts don't carry", () => {
    const { result } = ROSTER.lastCommand!;
    if (result.kind !== "admit") throw new Error("the fixture's last command was admitted");
    const details = ackDetails(result.parts!, result.revision, result.acknowledgment);
    expect(details.map((detail) => detail.label)).toEqual(["Added", "Kept", "Still included", "Excluded", "Still held", "Effects", "Not granted", "Starting", "Also"]);
    const text = Object.fromEntries(details.map((detail) => [detail.label, [detail.numbers, detail.text].filter(Boolean).join(" · ")]));
    expect(text).toMatchObject({ Added: "4-6 · move forward · rev 4", Kept: "1, 2 · already included; effects unchanged", Excluded: "3 · this instruction only, not a hold",
      "Still held": "8 · outlasts every instruction · release 8 to include", "Not granted": "mark ready, request review, merge",
      Also: "Instruction r4 · 16 PRs · stops at Ready · reports changes" });
    expect(text.Starting).toContain("2 fix failing checks · new worker: the only quill thread is busy on #185");
    expect(text.Starting).toContain("1 address review feedback · reused thread: idle, on the same branch");
    // Release includes only a held row the instruction includes: one this command leaves alone stays out, and a merge preview includes nothing (A2).
    const stillHeld = (parts: AckParts) => ackDetails(parts, 4).find((detail) => detail.label === "Still held");
    expect(stillHeld(parse("move 1-6 forward, leave 5 alone", [5, 8]))).toEqual({ label: "Still held", numbers: "5, 8",
      text: "outlasts every instruction · release 8 to include · 5 also left alone this instruction" });
    expect(stillHeld(parse("merge 8"))).toEqual({ label: "Still held", numbers: "8", text: "outlasts every instruction" });
    // What a recheck found is only in the text, so it shows; the plain line the parts already say doesn't repeat.
    const recheck = { ...result.parts!, added: [], kept: [], stillIncluded: [], leftAlone: [], effects: [], notGranted: [], starting: [],
      interventions: [{ action: "recheck" as const, release: false, targets: [{ target: target(17), n: 17 }] }] };
    expect(ackDetails(recheck, 4, ["Recheck: 17", "Recheck 17: short of Ready: approved"]).at(-1)).toEqual({ label: "Also", numbers: null, text: "Recheck 17: short of Ready: approved" });
  });

  it("shows where and when a command came from, and settles the rows it named", () => {
    const view = ackView({ ...ROSTER.lastCommand!, fresh: false }, NOW);
    expect(view.meta).toMatch(/^roster · \d\d:\d\d:\d\d · rev 4 · S-41a7c3e90b2d · 0 model turns$/u);
    expect(view.chips.at(-1)).toEqual({ kind: "no", label: "no merge" });
    const { result } = ROSTER.lastCommand!;
    expect(ackRows((result as Extract<typeof result, { kind: "admit" }>).parts!).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    // A thread command cost the parent a turn; a clarification changed nothing and has no chips.
    expect(ackView({ ...ROSTER.lastCommand!, origin: "thread", fresh: false }, NOW).meta).not.toContain("0 model turns");
    const clarified = ackView({ ...ROSTER.lastCommand!, result: { kind: "clarify", message: "move forward needs rows.", normalized: "move 1-6 forward" }, fresh: true }, NOW);
    expect(clarified).toMatchObject({ kind: "clarify", chips: [], details: [], message: "move forward needs rows.", normalized: "move 1-6 forward" });
  });

  it("composes a clicked number into the command, and a Shift-click into a range from the last one", () => {
    expect(composeNumber("", 4, false)).toBe("4");
    expect(composeNumber("move ", 4, false)).toBe("move 4");
    expect(composeNumber("move 4", 6, true)).toBe("move 4-6");
    expect(composeNumber("move 6", 4, true)).toBe("move 4-6");
    expect(composeNumber("move 4-6", 9, true)).toBe("move 4-9");
    expect(composeNumber("D2 13", 15, false)).toBe("D2 13 15");
    expect(composeNumber("hold ", 8, true)).toBe("hold 8");
  });

  it("shows a held answer as waiting only until the server journals what became of it, and this visit's newer command over an older one", () => {
    const journaled = ROSTER.lastCommand!;
    const held: CommandRecord = { requestId: "req-d1", text: "D1 A", origin: "panel", at: journaled.at + 60_000, revision: 4, snapshotId: journaled.snapshotId,
      result: { kind: "pending", requestId: "req-d1", text: "D1 A", decisions: [1], until: journaled.at + 70_000 }, fresh: true };
    expect(shownCommand(held, journaled)).toBe(held);
    // Admitted or refused when it fell due, it is journaled under the same request: that result replaces "Waits for Undo".
    const refused = { ...journaled, requestId: "req-d1", text: "D1 A", at: journaled.at + 71_000, result: { kind: "clarify" as const, message: "D1 changed since you read it.", normalized: null } };
    expect(shownCommand(held, refused)).toEqual({ ...refused, fresh: true });
    expect(ackView(shownCommand(held, refused)!, NOW).message).toBe("D1 changed since you read it.");
    // A command this visit sent at once stays as sent; a newer one from another surface wins.
    const admitted: CommandRecord = { ...journaled, fresh: true };
    expect(shownCommand(admitted, journaled)).toBe(admitted);
    expect(shownCommand({ ...admitted, requestId: "req-old", at: journaled.at - 1 }, journaled)).toEqual({ ...journaled, fresh: false });
    expect(shownCommand(null, journaled)).toEqual({ ...journaled, fresh: false });
  });

  it("puts you in the command box on /", () => {
    expect(rosterKey({ key: "/", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false }, { control: false, held: false })).toEqual({ kind: "command" });
  });
});

describe("roster decisions", () => {
  const { asks } = askCards(ROSTER);
  const ask = (id: string) => asks.find((item) => item.id === id) as DecisionAsk;
  const key = (name: string): KeyEvent => ({ key: name, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false });
  const start: PaneState = { focus: firstAsk(asks), open: null, picks: new Map(), subsets: new Map(), hint: null };
  /** Press keys in order through the same step the pane runs, collecting what each asks the pane to do. */
  function press(keys: string[], wide = true, state = start) {
    const effects: (PaneEffect | null)[] = [];
    for (const name of keys) {
      const step = paneKey(view(), asks, state, key(name), { control: false, wide });
      effects.push(step?.effect ?? null);
      if (step) state = step.state;
    }
    return { effects, state };
  }
  const sends = (effects: readonly (PaneEffect | null)[]) => effects.filter((effect) => effect?.kind === "answer")
    .map((effect) => answerCommand((effect as Extract<PaneEffect, { kind: "answer" }>).ask, (effect as Extract<PaneEffect, { kind: "answer" }>).reply));

  it("offers D1's options without preselecting its recommendation, and preselects D2's recommended drafts with the reason for leaving 14 out", () => {
    expect(asks.map((item) => [item.id, item.kind === "decision" ? item.answer : item.kind])).toEqual([["D1", "option"], ["D2", "subset"], ["S1", "issue"], ["M", "merge"]]);
    expect(ask("D1").options.map((option) => [option.key, option.id, option.recommended])).toEqual([["a", "A", true], ["b", "B", false]]);
    expect(ask("D1").recommended).toEqual([]);
    expect(ask("D2").recommended).toEqual([13, 15]);
    expect(ask("D2").targets.find((item) => item.n === 14)).toMatchObject({ note: "TODO left in the threshold", recommended: false, repo: "atlas", number: 85 });
    expect(start.focus).toEqual({ ask: "D1" });
  });

  it("does nothing on Enter at a product decision until you pick an option, at any width", () => {
    const wide = press(["Enter", "Enter", "Enter"]);
    expect(wide.effects).toEqual(Array(3).fill({ kind: "hint", text: "Pick A or B: product decisions need an explicit choice" }));
    expect(wide.state).toMatchObject({ focus: { ask: "D1" }, picks: new Map(), hint: { id: "D1", text: "Pick A or B: product decisions need an explicit choice" } });
    // Narrow, the first Enter opens the one-line ask, and the next still asks for an option.
    const narrow = press(["Enter", "Enter"], false);
    expect(narrow.effects).toEqual([null, { kind: "hint", text: "Pick A or B: product decisions need an explicit choice" }]);
    expect(narrow.state.open).toBe("D1");
  });

  it("answers D1 with the option you picked, accepts D2's subset and S1's recovery on Enter, and then rests on nothing", () => {
    const { effects, state } = press(["b", "a", "Enter", "Enter", "Enter", "Enter"]);
    expect(sends(effects)).toEqual(["D1 A", "D2 13 15"]);
    expect(effects[4]).toMatchObject({ kind: "recover", command: "recheck launches" });
    expect(effects[5]).toBeNull();
    expect(state.focus).toBeNull();
    // A subset you changed is the one Enter accepts; a letter picks nothing on a lifecycle ask.
    const changed = press(["j", "a", "Enter"], true, { ...start, subsets: new Map([[answerKey(ask("D2")), [13]]]) });
    expect(changed.state.picks.has(answerKey(ask("D2")))).toBe(false);
    expect(sends(changed.effects)).toEqual(["D2 13"]);
  });

  it("drops a pick or a subset once its question changes, so Enter can't send it to a question you never answered", () => {
    const picked = press(["b"]).state;
    const withSubset = { ...picked, subsets: new Map([[answerKey(ask("D2")), [13]]]) };
    // D1 and D2 come back at revision 2, D1 with a new question and relabelled options.
    const revised = { ...ROSTER, decisions: ROSTER.decisions.map((decision) => ({ ...decision, revision: 2,
      ...decision.n === 1 ? { question: "Out-of-print ISBNs: allow, block, or ask the Rare desk?", options: [...decision.options, { id: "C", label: "Ask the Rare desk", consequence: null }] } : {} })) };
    const cards = askCards(revised).asks;
    const step = (state: PaneState, focus: string) => paneKey(view("number", revised), cards, { ...state, focus: { ask: focus } }, key("Enter"), { control: false, wide: true });
    expect(step(withSubset, "D1")?.effect).toEqual({ kind: "hint", text: "Pick A, B, or C: product decisions need an explicit choice" });
    const d2 = step(withSubset, "D2")?.effect;
    expect(d2?.kind === "answer" && answerCommand(d2.ask, d2.reply)).toBe("D2 13 15");
    expect(d2?.kind === "answer" && answerInput(d2.ask, d2.reply, "req").expectedRevision).toBe(2);
  });

  it("asks for your words on a question asked without options, and names a worker's question for what it is", () => {
    const worker = (options: EffortRoster["decisions"][number]["options"]): EffortRoster => ({ ...ROSTER,
      decisions: ROSTER.decisions.map((decision) => decision.n === 1 ? { ...decision, kind: "worker-question", options, recommendation: null } : decision) });
    const enter = (roster: EffortRoster) => {
      const cards = askCards(roster).asks;
      return paneKey(view("number", roster), cards, { ...start, focus: { ask: "D1" } }, key("Enter"), { control: false, wide: true })?.effect;
    };
    const free = worker([{ id: "text", label: "Answer in your own words", consequence: null }]);
    expect((askCards(free).asks[0] as DecisionAsk).options).toEqual([]);
    expect(enter(free)).toEqual({ kind: "hint", text: "D1 has no options to pick: type your answer in its field, then Enter" });
    expect(enter(worker(ROSTER.decisions[0]!.options))).toEqual({ kind: "hint", text: "Pick A or B: worker questions need an explicit choice" });
  });

  it("sends a card's answer at the revision it showed, held for the server's Undo window", () => {
    expect(UNDO_WINDOW).toBe(ANSWER_DELAY);
    expect(answerInput(ask("D1"), { optionId: "A" }, "req-a")).toEqual({ decisionId: "dec-shelving-1", optionId: "A", expectedRevision: 1, requestId: "req-a", delayMs: 10_000 });
    expect(answerCommand(ask("D2"), { numbers: [13, 15] })).toBe("D2 13 15");
    expect(answerCommand(ask("D2"), { numbers: [] })).toBe("D2 none");
  });

  it("sends the number field through the grammar, so all but 14 marks exactly 13 and 15", () => {
    const input = fieldAnswerInput(ROSTER, ask("D2"), " all but 14 ", "req-f");
    expect(input).toEqual({ effortId: ROSTER.effort.id, snapshotId: ROSTER.snapshotId, text: "D2 all but 14", requestId: "req-f", source: "panel", expectedRevision: 4,
      decisions: [{ n: 2, revision: 1 }], delayMs: 10_000 });
    const read = interpretEffortCommand(input.text, { effortId: ROSTER.effort.id, issued: new Map(ROSTER.rows.map((row) => [row.n, row.target])), rows: new Map(), holds: {},
      snapshot: { id: ROSTER.snapshotId!, effortId: ROSTER.effort.id, stale: false, rows: ROSTER.rows.map(({ n, target }) => ({ n, target })) }, instruction: null, lastRevision: 4,
      decisions: [{ n: 2, options: [], targets: [13, 14, 15] }], ownerOf: () => ({ effortId: ROSTER.effort.id, name: ROSTER.effort.name }) });
    expect(read.kind === "admit" && read.answers).toEqual([{ decision: 2, numbers: [13, 15] }]);
  });

  it("shows an answer waiting for Undo as a receipt in place of its card, and takes back the newest on u", () => {
    const waiting = { ...ROSTER, pending: [{ requestId: "req-d1", text: "D1 A", decisions: [1], until: NOW + 8_000 }] };
    const cards = askCards(waiting);
    expect(cards.asks.map((item) => item.id)).toEqual(["D2", "S1", "M"]);
    expect(cards.receipts).toEqual([{ requestId: "req-d1", text: "D1 A", decisions: [1], until: NOW + 8_000, id: "D1", numbers: [7, 12] }]);
    const later = { ...cards.receipts[0]!, requestId: "req-d2", id: "D2", until: NOW + 9_000 };
    expect(latestUndo([cards.receipts[0]!, later], NOW)?.requestId).toBe("req-d2");
    expect(latestUndo([cards.receipts[0]!], NOW + 8_000)).toBeNull();
    expect(press(["u"]).effects).toEqual([{ kind: "undo" }]);
  });

  it("keeps row keys off an ask, so c picks option C there and rechecks only on a row", () => {
    expect(rosterKey(key("c"), { control: false, held: false, ask: true })).toEqual({ kind: "option", index: 2 });
    expect(rosterKey(key("r"), { control: false, held: false, ask: true })).toBeNull();
    expect(rosterKey(key("c"), { control: false, held: false })).toEqual({ kind: "row", id: "recheck" });
    // j walks from the asks into the rows.
    expect(press(["j", "j", "j", "j"]).state.focus).toEqual({ row: 1 });
  });
});

describe("roster system issues", () => {
  const { asks } = askCards(ROSTER);
  const s1 = asks.find((item) => item.id === "S1")!;
  const key = (name: string): KeyEvent => ({ key: name, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false });
  const at = (focus: PaneState["focus"]): PaneState => ({ focus, open: null, picks: new Map(), subsets: new Map(), hint: null });

  it("lists S1 after the decisions with its recoveries, and runs on Enter only the one that drops no claim", () => {
    expect(s1).toMatchObject({ kind: "issue", numbers: [17], primary: { command: "recheck launches", confirm: false } });
    expect(paneKey(view(), asks, at({ ask: "S1" }), key("Enter"), { control: false, wide: true })?.effect).toMatchObject({ kind: "recover", command: "recheck launches" });
  });

  it("confirms a recovery that drops a claim, naming the likely thread, and sends every other one", () => {
    const [recheck, reset] = (s1 as IssueAsk).issue.recovery;
    expect(recoveryIntent(s1 as IssueAsk, recheck!)).toEqual({ kind: "send", command: "recheck launches" });
    expect(recoveryIntent(s1 as IssueAsk, reset!)).toEqual({ kind: "confirm", reset: { command: "reset 17 release", label: "17", numbers: [17], threadId: "thr_folio_421" } });
  });

  it("never runs reset N release on one key: an issue with only that recovery points you at its confirm", () => {
    const resetOnly = { ...ROSTER, issues: ROSTER.issues.map((issue) => ({ ...issue, recovery: issue.recovery.filter((item) => item.confirm) })) };
    const cards = askCards(resetOnly).asks;
    const step = paneKey(view("number", resetOnly), cards, at({ ask: "S1" }), key("Enter"), { control: false, wide: true });
    expect(step?.effect).toEqual({ kind: "hint", text: "Reset 17… needs your confirmation first: use its button" });
    expect(step?.state.focus).toEqual({ ask: "S1" });
  });
});

describe("keyboard safety: Enter never merges", () => {
  const { asks } = askCards(ROSTER);
  const key = (name: string, chord = false): KeyEvent => ({ key: name, shiftKey: false, metaKey: chord, ctrlKey: false, altKey: false });
  const at = (focus: PaneState["focus"]): PaneState => ({ focus, open: null, picks: new Map(), subsets: new Map(), hint: null });
  function press(keys: (string | KeyEvent)[], state: PaneState, wide = true) {
    const effects: (PaneEffect | null)[] = [];
    for (const name of keys) {
      const step = paneKey(view(), asks, state, typeof name === "string" ? key(name) : name, { control: false, wide });
      effects.push(step?.effect ?? null);
      if (step) state = step.state;
    }
    return { effects, state };
  }
  const kinds = (effects: readonly (PaneEffect | null)[]) => effects.map((effect) => effect === null ? null : effect.kind === "answer" || effect.kind === "recover"
    || effect.kind === "preview" ? `${effect.kind} ${effect.kind === "answer" ? answerCommand(effect.ask, effect.reply) : effect.command}` : effect.kind);

  it("clears the returning batch with a ⏎ ⏎ ⏎ m, and Enter pressed on after it only ever reaches the preview, never a merge", () => {
    const { effects, state } = press(["a", "Enter", "Enter", "Enter", "m", "Enter", "Enter", "Enter", " ", "Enter"], at(firstAsk(asks)));
    expect(kinds(effects)).toEqual([null, "answer D1 A", "answer D2 13 15", "recover recheck launches", "preview merge 9 16",
      "preview merge 9 16", "preview merge 9 16", "preview merge 9 16", "seen", "preview merge 9 16"]);
    // m leaves focus on M, where Enter reopens the same preview; the merge itself happens only in the preview, on a click or ⌘↵.
    expect(state.focus).toEqual({ ask: "M" });
  });

  it("never moves focus onto M after an answer: after the last decision or system issue it rests on nothing", () => {
    const { effects, state } = press(["a", "Enter", "Enter", "Enter", "Enter", "Enter", " ", "Enter"], at(firstAsk(asks)));
    expect(kinds(effects).slice(4)).toEqual([null, null, "seen", null]);
    expect(state.focus).toBeNull();
    expect(afterAnswer(asks, at({ ask: "S1" }), "S1", true).focus).toBeNull();
  });

  it("gives no key on any ask or row an effect that merges: at most it opens the fresh preview", () => {
    const places: PaneState["focus"][] = [null, ...asks.map((item) => ({ ask: item.id })), ...ROSTER.rows.map((row) => ({ row: row.n }))];
    const allowed = new Set(["answer", "recover", "preview", "hint", "row", "menu", "order", "seen", "keys", "command", "undo"]);
    for (const focus of places) for (const wide of [true, false]) {
      const { effects } = press(["Enter", "Enter", " ", "m", key("Enter", true), "Enter"], at(focus), wide);
      for (const effect of effects) {
        if (effect) expect(allowed.has(effect.kind), `${JSON.stringify(focus)}: ${effect.kind}`).toBe(true);
        if (effect?.kind === "preview") expect(effect.command).toMatch(/^merge \d+( \d+)*$/u);
      }
      // ⌘↵ belongs to the preview's own dialog; on the pane it does nothing.
      expect(paneKey(view(), asks, at(focus), key("Enter", true), { control: false, wide })).toBeNull();
    }
  });

  it("opens a Ready row's own preview on Enter, and names M's candidates and the stack they wake", () => {
    expect(press(["Enter"], at({ row: 16 })).effects).toEqual([{ kind: "preview", command: "merge 16" }]);
    expect(press(["Enter"], at({ row: 5 })).effects).toEqual([{ kind: "row", n: 5, id: "thread" }]);
    expect(asks.find((item) => item.id === "M")).toEqual({ kind: "merge", id: "M", numbers: [9, 16], wakes: [{ n: 9, children: [10, 11] }], command: "merge 9 16" });
    // A held Ready row isn't a candidate.
    const held = { ...ROSTER, rows: ROSTER.rows.map((row) => row.n === 16 ? { ...row, hold: { reason: "", heldAt: NOW } } : row) };
    expect(askCards(held).asks.find((item) => item.id === "M")).toMatchObject({ numbers: [9], command: "merge 9" });
  });

  it("reads merge 9 16 as a preview that grants nothing, so the command that opens the preview can't merge", () => {
    const read = interpretEffortCommand("merge 9 16", { effortId: ROSTER.effort.id, issued: new Map(ROSTER.rows.map((row) => [row.n, row.target])), rows: new Map(), holds: {},
      snapshot: { id: ROSTER.snapshotId!, effortId: ROSTER.effort.id, stale: false, rows: ROSTER.rows.map(({ n, target }) => ({ n, target })) }, instruction: null, lastRevision: 4,
      decisions: [], ownerOf: () => ({ effortId: ROSTER.effort.id, name: ROSTER.effort.name }) });
    if (read.kind !== "admit") throw new Error(read.message);
    expect(read.mergePreviews.map((item) => item.n)).toEqual([9, 16]);
    expect(read).toMatchObject({ instruction: null, interventions: [], answers: [], parts: { merge: false, added: [], notGranted: [] } });
  });
});
