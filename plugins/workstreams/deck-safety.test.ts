// The deck sends batch writes only after the listing confirm and merges only from a fresh preview.
// All PRs exposes one direct write: an explicit Nudge button when the server-derived action is eligible.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
const VIEWS = ["deck-nav-view.tsx", "deck-screen.tsx", "deck-flow.tsx", "inventory-screen.tsx"];

describe("the deck's write safety", () => {
  it("starts a batch in one place, which only the listing confirm's button or ⌘↵ on its dialog reaches", () => {
    expect(VIEWS.flatMap((file) => [...source(file).matchAll(/"deck_batch_start"/gu)].map(() => file))).toEqual(["deck-flow.tsx"]);
    const flow = source("deck-flow.tsx");
    expect([...flow.matchAll(/(on\w+)=\{\(\) => void start\(\)\}/gu)].map((match) => match[1])).toEqual(["onConfirmKey", "onConfirm"]);
    expect(flow.match(/void start\(\)/gu)).toHaveLength(2);
  });

  // A weak suggestion rests on one faint signal, so its PRs move only after you check each one's signals.
  it("moves a weak group's PRs only from its confirm's button or ⌘↵", () => {
    const nav = source("deck-nav-view.tsx");
    // Its button and the accept key open the confirm first.
    expect(nav).toMatch(/const rows = asked \?\? [^\n]+\n\s+if \(!rows\.length\) return;\n\s+if \(group\.button\.confirm && !asked\) \{ openDialog\(\{ kind: "weak"/u);
    // Only the confirm passes the rows you checked.
    expect(nav.match(/asked: /gu)).toHaveLength(1);
    expect(nav).toMatch(/if \(dialog\?\.kind === "weak" && !busy\) acceptGroup\(dialog\.group, \{ asked: dialog\.lines \}\)/u);
    expect([...nav.matchAll(/(on\w+)=\{\(\) => acceptWeak\(\)\}/gu)].map((match) => match[1])).toEqual(["onConfirmKey", "onAccept"]);
    expect(nav.match(/(?<!function )acceptWeak\(\)/gu)).toHaveLength(2);
  });

  // A17.1: promoting a service card makes an effort of all its PRs at once, so it goes through the new effort dialog's one confirm.
  it("promotes a service card only from the new effort dialog's Create button or ⌘↵", () => {
    const nav = source("deck-nav-view.tsx");
    expect(nav).toMatch(/case "promote": \{[^}]+openDialog\(\{ kind: "new", prUrls: list\.map/u);
    expect(nav.match(/"classify_new_effort"/gu)).toHaveLength(1);
    expect(nav).toMatch(/function createEffort\(\) \{\n\s+if \(dialog\?\.kind !== "new" \|\| busy/u);
    expect([...nav.matchAll(/(on\w+)=\{\(\) => createEffort\(\)\}/gu)].map((match) => match[1])).toEqual(["onConfirmKey", "onCreate"]);
  });

  // A confirmation clears the merge gate on your word, so it comes only from one PR's notes, read fresh: its own button, or ⌘↵ only when
  // something since the approval shows the notes handled. Confirming without evidence is a click on Confirm anyway alone.
  it("records a confirmation only from a PR's notes: Confirm handled or ⌘↵ with evidence, and Confirm anyway only on its own click", () => {
    expect([...VIEWS, "notes-flow.tsx"].flatMap((file) => [...source(file).matchAll(/"inventory_confirm_handled"/gu)].map(() => file))).toEqual(["notes-flow.tsx"]);
    const notes = source("notes-flow.tsx");
    expect([...notes.matchAll(/(on\w+)=\{\(\) => void confirmNotes\((true|false)\)\}/gu)].map((match) => [match[1], match[2]]))
      .toEqual([["onConfirm", "false"], ["onAnyway", "true"]]);
    expect(notes).toMatch(/const lead = \(\) => \{ if \(screen\?\.primary === "confirm"\) void confirmNotes\(false\); else if \(screen\?\.primary === "ask"\) ask\(\); \};/u);
    expect(notes).toMatch(/onConfirmKey=\{lead\}/u);
    expect(notes.match(/confirmNotes\(true\)/gu)).toHaveLength(1);
  });

  // A slow read for one PR must never fill the dialog opened for another, whose buttons would then confirm or ask on the wrong notes.
  it("lets a notes read or confirmation land only in the dialog opening it belongs to", () => {
    const notes = source("notes-flow.tsx");
    expect(notes).toMatch(/const land = \(result: ConfirmRead\) => \{ if \(opened\.current === id\) setRead\(result\); \};/u);
    expect(notes.match(/setRead\(/gu)).toHaveLength(2);
    expect(notes).toMatch(/const current = opened\.current === id;/u);
  });

  it("never calls a GitHub write or a merge from the deck: only the batch confirm and the fresh merge preview do", () => {
    for (const file of ["deck-nav-view.tsx", "deck-screen.tsx", "deck-flow.tsx"]) {
      expect(source(file)).not.toMatch(/"(inventory_(mark_ready|request_review|nudge|confirm_handled)|action_merge)"/u);
    }
    // All PRs exposes only explicit Start and eligible Nudge buttons. Its keys move focus, and n, its one key that writes, opens the same
    // listing confirm as the deck's; its Nudge button stays one click, its only direct call besides the read.
    const inventory = source("inventory-screen.tsx");
    expect(inventory).toMatch(/case "nudge": if \(focused && due\) void batch\.plan\("nudge", null, \[focused\.prUrl\]\); return;/u);
    expect(inventory.match(/batch\.plan\(/gu)).toHaveLength(1);
    expect([...inventory.matchAll(/rpc\.call\("(\w+)"/gu)].map((match) => match[1])).toEqual(["inventory_get", "inventory_nudge"]);
    // Review notes and merges are the deck's alone: no key or button here confirms or merges.
    expect(inventory).not.toMatch(/case "(confirm|request|ready|merge)"/u);
    expect(inventory).not.toContain('"inventory_confirm_handled"');
    expect(inventory).not.toContain('"action_merge"');
    const rows = source("inventory-rows.tsx");
    expect(rows).toContain('action.id === "nudge" && action.enabled');
    expect(rows).toContain('onClick={() => props.onNudge(line, nudge)}');
    expect(rows).toContain('onClick={() => props.onStart(item)}');
  });
});
