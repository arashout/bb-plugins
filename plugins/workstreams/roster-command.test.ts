import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { INKWELL_SHELVING_ROSTER as ROSTER, SHELVING_ROSTER_NOW as NOW } from "./inkwell-fixtures";
import { CommandBox, COMMAND_PLACEHOLDER, type CommandBoxProps } from "./roster-command";
import { ackView, type CommandRecord } from "./roster-view-model";

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
