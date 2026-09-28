import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EffortRoster } from "./effort-roster";
import { INKWELL_SHELVING_ROSTER as ROSTER, SHELVING_ROSTER_NOW as NOW } from "./inkwell-fixtures";
import { AsksBlock } from "./roster-asks";
import { answerKey, askCards, firstAsk, type DecisionAsk, type PaneState } from "./roster-view-model";

const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/&quot;/gu, "\"").replace(/&#x27;/gu, "'").replace(/\s+/gu, " ").trim();
const start = (roster: EffortRoster): PaneState => ({ focus: firstAsk(askCards(roster).asks), open: null, picks: new Map(), subsets: new Map(), hint: null });
function asks(options: { wide?: boolean; roster?: EffortRoster; state?: Partial<PaneState> } = {}) {
  const roster = options.roster ?? ROSTER;
  return renderToStaticMarkup(createElement(AsksBlock, { ...askCards(roster), state: { ...start(roster), ...options.state }, wide: options.wide ?? true, now: NOW,
    onFocusAsk: noop, onFocus: noop, onAnswer: noop, onField: noop, onSubset: noop, onCompose: noop, onUndo: noop, onRecover: noop, onOpenThread: noop, onOpenUrl: noop }));
}
const keyOf = (id: string, roster = ROSTER) => answerKey(askCards(roster).asks.find((ask) => ask.id === id) as DecisionAsk);
const card = (html: string, id: string) => html.match(new RegExp(`<article data-roster-ask="${id}"[\\s\\S]*?</article>`, "u"))?.[0] ?? "";

describe("roster decision cards", () => {
  it("shows D1's evidence and each option's consequence, tags the recommendation, and picks nothing for you", () => {
    const d1 = card(asks(), "D1");
    expect(text(d1)).toContain("Out-of-print ISBNs at entry: allow them, or block them?");
    expect(text(d1)).toContain("Evidence: review thread on folio #415 · ABC-318 acceptance note");
    expect(text(d1)).toContain("A Allow, and show an \"Out of print\" badge Recommended 12 already renders the badge; 7 adds one check");
    expect(text(d1)).toContain("Recommended A: Matches the ABC-318 acceptance note");
    expect(d1).not.toContain('aria-pressed="true"');
    expect(d1).toContain('title="Sends D1 A; Undo for 10 s"');
    expect(text(d1)).toMatch(/Thread D1 A · D1 B$/u);
  });

  it("says why Enter did nothing on D1, in the card", () => {
    const hint = "Pick A or B: product decisions need an explicit choice";
    expect(text(card(asks({ state: { hint: { id: "D1", text: hint } } }), "D1"))).toContain(hint);
    expect(text(card(asks({ state: { picks: new Map([[keyOf("D1"), "B"]]) } }), "D1"))).toContain("Enter sends D1 B");
    expect(card(asks({ state: { picks: new Map([[keyOf("D1"), "B"]]) } }), "D1")).toMatch(/aria-pressed="true" data-option="B"/u);
    // A pick made on an earlier revision of the question shows nothing picked on the new one.
    const revised = { ...ROSTER, decisions: ROSTER.decisions.map((decision) => ({ ...decision, revision: decision.revision + 1 })) };
    const stale = card(asks({ roster: revised, state: { picks: new Map([[keyOf("D1"), "B"]]) } }), "D1");
    expect(stale).not.toContain('aria-pressed="true"');
    expect(text(stale)).toContain("a / b picks, then Enter; nothing is preselected");
  });

  it("opens the words field on a worker's question asked without options, without taking focus, and names it a worker question", () => {
    const free = { ...ROSTER, decisions: ROSTER.decisions.map((decision) => decision.n === 1
      ? { ...decision, kind: "worker-question", options: [{ id: "text", label: "Answer in your own words", consequence: null }], recommendation: null } : decision) };
    const d1 = card(asks({ roster: free }), "D1");
    expect(text(d1)).toContain("D1 Worker question 7 12");
    expect(d1).not.toContain('role="group"');
    expect(d1).toMatch(/<input[^>]*aria-label="D1 in your words"/u);
    expect(d1).not.toMatch(/<input[^>]*autofocus/iu);
    expect(text(d1)).toMatch(/No options were offered: answer in your words, then Enter Thread D1$/u);
    expect(text(asks({ roster: free, wide: false, state: { open: null } }))).toContain("D1 7 12 · worker question · Out-of-print ISBNs");
  });

  it("preselects D2's recommended drafts, gives 14's TODO as the reason it's left out, and shows the thread text for the selection", () => {
    const d2 = card(asks(), "D2");
    expect(d2.match(/aria-label="Include (\d+)"/gu)).toHaveLength(3);
    expect([...d2.matchAll(/aria-checked="(true|false)"[^>]*aria-label="Include (\d+)"/gu)].map((match) => [match[2], match[1]]))
      .toEqual([["13", "true"], ["14", "false"], ["15", "true"]]);
    expect(text(d2)).toContain("14 atlas #85 Shelf capacity warnings TODO left in the threshold");
    expect(text(d2)).toContain("Mark 13, 15 ready Keep all as drafts or");
    expect(d2).toContain('placeholder="13 15 · all · all but 14"');
    expect(text(d2)).toContain("Recommended 13, 15: 14 still has a TODO in its threshold");
    expect(text(d2)).toMatch(/Thread D2 13 15$/u);
    expect(text(card(asks({ state: { subsets: new Map([[keyOf("D2"), []]]) } }), "D2"))).toMatch(/Keep all as drafts or .*Thread D2 none$/u);
  });

  it("draws one line per ask in a narrow pane and opens only the one you open", () => {
    const narrow = asks({ wide: false, state: { open: null } });
    expect(narrow).not.toContain("<article");
    expect(text(narrow)).toContain("D1 7 12 · product · Out-of-print ISBNs at entry: allow them, or block them?");
    expect(text(narrow)).toContain("D2 13 14 15 · lifecycle · Mark these drafts ready for review?");
    const open = asks({ wide: false, state: { open: "D2" } });
    expect(open.match(/<article/gu)).toHaveLength(1);
    expect(card(open, "D2")).not.toBe("");
  });

  it("replaces an answered card with a receipt that counts down to its send and offers Undo", () => {
    const waiting = { ...ROSTER, pending: [{ requestId: "req-d1", text: "D1 A", decisions: [1], until: NOW + 7_400 }] };
    const html = asks({ roster: waiting });
    expect(card(html, "D1")).toBe("");
    expect(text(html)).toContain("✓ D1 D1 A sends in 8s · 7, 12 get it in their next step Undo · 8s");
    expect(text(asks({ roster: { ...waiting, pending: [{ ...waiting.pending[0]!, until: NOW - 1 }] } }))).not.toContain("Undo");
  });
});

describe("roster system issues", () => {
  it("shows S1 in rose with its recoveries, running recheck launches on Enter and confirming the reset", () => {
    const s1 = card(asks(), "S1");
    expect(s1).toContain('data-tone="issue"');
    expect(s1).not.toMatch(/amber/u);
    expect(text(s1)).toContain("S1 System issue 17");
    expect(text(s1)).toContain("Launch outcomes uncertain; new launches paused Readback hasn't found the worker for 17 or ruled one out; running work continues");
    expect(s1).toContain('title="Sends recheck launches"');
    expect(s1).toContain('title="Asks you to confirm no worker is writing, then sends reset 17 release"');
    expect(text(s1)).toContain("Recheck launches Reset 17… Open likely thread");
    expect(text(s1)).toMatch(/Enter sends recheck launches Thread recheck launches · reset 17 release$/u);
  });

  it("keeps the first recovery on S1's line in a narrow pane", () => {
    const narrow = asks({ wide: false, state: { open: null } });
    expect(text(narrow)).toContain("S1 17 · system · Launch outcomes uncertain; new launches paused › Recheck launches");
  });
});
