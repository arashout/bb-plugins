import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { INKWELL_SHELVING_ROSTER as ROSTER, SHELVING_ROSTER_NOW as NOW } from "./inkwell-fixtures";
import { CommandBox, COMMAND_PLACEHOLDER, ParentBannerStrip, type CommandBoxProps } from "./roster-command";
import { ackView, bannerCommandInput, parentSummary, type CommandRecord, type ParentContext } from "./roster-view-model";

const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/&quot;/gu, "\"").replace(/&#x27;/gu, "'").replace(/\s+/gu, " ").trim();
function box(record: CommandRecord | null, props: Partial<CommandBoxProps> = {}) {
  return renderToStaticMarkup(createElement(CommandBox, { value: "", onValue: noop, onSubmit: noop, onToggle: noop, onLeave: noop, note: null,
    ack: record && ackView(record, NOW), open: false, ...props }));
}
const last = (fresh: boolean): CommandRecord => ({ ...ROSTER.lastCommand!, fresh });

describe("roster command box markup", () => {
  it("shows the last command with its chip row, and its details only when open", () => {
    const closed = box(last(false));
    expect(text(closed)).toContain("› move 1-6 forward, leave 3 alone");
    expect([...closed.matchAll(/data-ack-chip="(\w+)"[^>]*>(.*?)<\/span>/gu)].map((match) => text(match[2]!)))
      .toEqual(["+4-6 added", "1, 2 kept", "3 left alone, not a hold", "8 held, hold wins", "no merge"]);
    expect(closed).toContain(">Details</button>");
    expect(closed).not.toContain("<dl");
    const open = text(box(last(true), { open: true }));
    for (const label of ["Added 4-6 · move forward · rev 4", "Excluded 3 · this instruction only, not a hold", "Still held 8 · outlasts every instruction",
      "Not granted mark ready, request review, merge", "Starting"]) expect(open).toContain(label);
    expect(open).toContain("Hide details");
  });

  it("shows a clarification's message and offers its reading, with no chip row, because nothing ran", () => {
    const html = box({ ...last(true), text: "move forward", result: { kind: "clarify", message: "move forward needs rows, for example: move 1-3 forward.",
      normalized: "move 1-6 forward" } });
    expect(text(html)).toContain("Nothing ran. move forward needs rows, for example: move 1-3 forward.");
    expect(text(html)).toContain("Use this: move 1-6 forward");
    expect(html).not.toContain("data-ack-chip");
    expect(html).not.toContain(">Details</button>");
  });

  it("offers the same grammar as the thread in its placeholder, and shows a note beside the last command", () => {
    const html = box(null, { value: "hold 8 because ", note: { command: "refresh 5", lines: ["5 read from GitHub just now"], tone: "info" } });
    expect(html).toContain(`placeholder="${COMMAND_PLACEHOLDER}"`);
    expect(COMMAND_PLACEHOLDER).toMatch(/^Command, same grammar as the thread: hold 8 because…, D2 all but 14/u);
    expect(html).toContain('value="hold 8 because "');
    expect(text(html)).toContain("› refresh 5 5 read from GitHub just now");
  });

  it("keeps roster keys on the pane root, never on window or document, so typing in the thread's composer can't trigger them", () => {
    const source = readFileSync(new URL("./roster-view.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/(?:window|document)\.addEventListener\(\s*["']key/u);
    expect(source).toMatch(/role="region"[^>]*tabIndex=\{-1\} onKeyDown=\{props\.onKeyDown\}/u);
  });
});

describe("effort parent banner", () => {
  /** effort_parent_context for the fixture's parent thread: five rows wait on two decisions, and S1 pauses launches without a row in an issue. */
  const PARENT: ParentContext = { effort: { id: ROSTER.effort.id, name: ROSTER.effort.name, archived: false }, snapshotId: ROSTER.snapshotId, revision: 4,
    decisions: [{ n: 1, revision: 1 }, { n: 2, revision: 1 }], counts: { doing: 4, waiting: 5, decision: 5, ready: 2, issue: 0, done: 2 }, issues: 1 };
  const banner = (context: ParentContext | null, ack: CommandRecord | null = null) => renderToStaticMarkup(createElement(ParentBannerStrip,
    { context, value: "", onValue: noop, onSubmit: noop, onOpenRoster: noop, ack: ack && ackView(ack, NOW) }));

  it("shows what needs you, Open roster, and a command field in an effort parent thread", () => {
    const html = banner(PARENT);
    expect(text(html)).toContain("Shelving entry · Effort parent · rev 4 · 2 decisions · 1 system issue · 2 ready Open roster");
    expect(html).toContain('aria-label="Command for Shelving entry"');
    expect(html).toContain(`numbers from roster ${ROSTER.snapshotId}`);
  });

  it("renders nothing in any other thread, which leaves today's effort picker as the whole banner", () => {
    expect(banner(null)).toBe("");
  });

  it("counts asks by decision and system issue, not by the rows that wait on them, and says so only when nothing asks", () => {
    expect(parentSummary(PARENT)).toBe("Effort parent · rev 4 · 2 decisions · 1 system issue · 2 ready");
    // Paused launches are an ask though no row is in an issue, so the banner never says "no asks" while they are.
    expect(parentSummary({ ...PARENT, decisions: [], counts: { ...PARENT.counts, decision: 0 } })).toBe("Effort parent · rev 4 · 1 system issue · 2 ready");
    expect(parentSummary({ ...PARENT, decisions: [], counts: { ...PARENT.counts, decision: 0, issue: 3 }, issues: 2 })).toBe("Effort parent · rev 4 · 2 system issues · 2 ready");
    expect(parentSummary({ ...PARENT, revision: null, decisions: [], issues: 0, counts: { ...PARENT.counts, decision: 0, ready: 0 }, effort: { ...PARENT.effort, archived: true } }))
      .toBe("Effort parent · no instruction · no asks · 0 ready · archived");
  });

  it("sends from the banner at once, answering only the decisions its context showed", () => {
    expect(bannerCommandInput(PARENT, "D1 A", "req-9")).toEqual({ effortId: ROSTER.effort.id, snapshotId: ROSTER.snapshotId, text: "D1 A", requestId: "req-9", source: "banner",
      expectedRevision: 4, decisions: [{ n: 1, revision: 1 }, { n: 2, revision: 1 }] });
    expect(bannerCommandInput(PARENT, "D1 A", "req-9")).not.toHaveProperty("delayMs");
  });

  it("shows a command's chip row inline, and a clarification with nothing run", () => {
    expect(text(banner(PARENT, { ...ROSTER.lastCommand!, origin: "banner", fresh: true }))).toContain("+4-6 added 1, 2 kept 3 left alone, not a hold 8 held, hold wins no merge");
    const clarified = text(banner(PARENT, { ...ROSTER.lastCommand!, text: "D1", result: { kind: "clarify", message: "D1 takes one of its options (A, B).", normalized: null }, fresh: true }));
    expect(clarified).toContain("› D1 Nothing ran. D1 takes one of its options (A, B).");
    expect(clarified).not.toContain("no merge");
  });
});
