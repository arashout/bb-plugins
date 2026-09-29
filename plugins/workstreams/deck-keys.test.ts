import { describe, expect, it } from "vitest";
import { ACTION, actionForKey, DECK_ACTIONS, KEY_GROUPS, typingTarget } from "./deck-keys.js";

describe("the deck's key registry", () => {
  it("gives each key one meaning, so the same letter does the same thing in the deck and All PRs", () => {
    const keys = DECK_ACTIONS.flatMap((action) => action.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(DECK_ACTIONS.every((action) => KEY_GROUPS.includes(action.group))).toBe(true);
    expect(new Set(DECK_ACTIONS.map((action) => action.id)).size).toBe(DECK_ACTIONS.length);
  });

  it("never binds Enter or Space to a merge or a write: Enter only opens a row's details", () => {
    expect(actionForKey({ key: "Enter" })).toEqual({ id: "expand" });
    expect(actionForKey({ key: " " })).toBeNull();
    for (const action of DECK_ACTIONS.filter((item) => item.effect === "confirm" || item.effect === "preview")) {
      expect(action.keys).not.toContain("↵");
      expect(action.keys).not.toContain(" ");
    }
    // ⌘↵ merges only inside the fresh merge preview, which owns that key; the deck never reads it as an action.
    expect(actionForKey({ key: "Enter", metaKey: true })).toBeNull();
    expect(actionForKey({ key: "Enter", ctrlKey: true })).toBeNull();
  });

  it("opens a listing confirm, or the fresh merge preview, for every key that can lead to a GitHub write", () => {
    const writes = ["advance", "merge", "confirm", "nudge", "request", "ready"] as const;
    expect(writes.map((id) => [id, ACTION[id].effect])).toEqual([["advance", "confirm"], ["merge", "preview"], ["confirm", "confirm"], ["nudge", "confirm"],
      ["request", "confirm"], ["ready", "confirm"]]);
    expect(["a", "m", "c", "n", "r", "y"].map((key) => actionForKey({ key })?.id)).toEqual([...writes]);
    // Nothing else reaches a write: every other action moves, changes the view, or opens a dialog.
    expect(DECK_ACTIONS.filter((action) => action.effect === "confirm" || action.effect === "preview").map((action) => action.id).sort()).toEqual([...writes].sort());
  });

  it("repeats only row movement while a key is held, so a held a or n can't open two confirms", () => {
    expect(actionForKey({ key: "j", repeat: true })).toEqual({ id: "row-next" });
    expect(actionForKey({ key: "ArrowUp", repeat: true })).toEqual({ id: "row-prev" });
    expect(actionForKey({ key: "a", repeat: true })).toBeNull();
    expect(actionForKey({ key: "3", repeat: true })).toBeNull();
  });

  it("reads arrows, brackets, numbers, Shift-X, and ⌘K, and ignores other modified keys", () => {
    expect(["]", "ArrowRight", "[", "ArrowLeft"].map((key) => actionForKey({ key })?.id)).toEqual(["next", "next", "prev", "prev"]);
    expect(actionForKey({ key: "4" })).toEqual({ id: "jump", n: 4 });
    expect(actionForKey({ key: "0" })).toBeNull();
    expect(actionForKey({ key: "X", shiftKey: true })).toEqual({ id: "select-section" });
    expect(actionForKey({ key: "k", metaKey: true })).toEqual({ id: "palette" });
    expect(actionForKey({ key: "a", altKey: true })).toBeNull();
    expect(actionForKey({ key: "c", ctrlKey: true })).toBeNull();
  });

  it("leaves typing alone", () => {
    expect(typingTarget({ closest: (selector: string) => selector.includes("textarea") ? {} : null })).toBe(true);
    expect(typingTarget({ closest: () => null })).toBe(false);
    expect(typingTarget(null)).toBe(false);
  });
});
