// The deck's write safety, read from the view modules' source: no key, button, or palette entry writes to GitHub on its own. A batch
// sends only from the listing confirm, after its Undo window, and a merge only from the fresh merge preview. A new direct call in any
// of these files fails here.
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

  it("never calls a GitHub write or a merge from the deck: only the batch confirm and the fresh merge preview do", () => {
    for (const file of ["deck-nav-view.tsx", "deck-screen.tsx", "deck-flow.tsx"]) {
      expect(source(file)).not.toMatch(/"(inventory_(mark_ready|request_review|nudge|confirm_handled)|action_merge)"/u);
    }
    // All PRs' keys go through the same confirm; its row buttons stay one click each, as before the deck.
    expect(source("inventory-screen.tsx")).toMatch(/case "confirm": case "nudge": case "request": case "ready": if \(focused\) void batch\.plan\(/u);
  });
});
