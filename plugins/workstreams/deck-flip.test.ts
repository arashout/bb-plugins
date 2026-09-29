import { describe, expect, it } from "vitest";
import { behind } from "./deck-flip.js";

const RING = ["shelf", "pickup", "one-offs", "unc"].map((id) => ({ id }));
const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);

describe("the deck as a stack", () => {
  // What lies behind the top card is what ] reaches next, so the stack never shows a card a flip forward wouldn't land on.
  it("puts the next three cards behind the one shown, in the order ] reaches them, wrapping past Unclassified to the first effort", () => {
    expect(ids(behind(RING, "shelf"))).toEqual(["pickup", "one-offs", "unc"]);
    expect(ids(behind(RING, "one-offs"))).toEqual(["unc", "shelf", "pickup"]);
    expect(ids(behind(RING, "unc"))).toEqual(["shelf", "pickup", "one-offs"]);
  });

  it("never puts the card shown behind itself, so a short pile shows fewer cards behind, and nothing before the first read", () => {
    expect(ids(behind(RING.slice(0, 2), "pickup"))).toEqual(["shelf"]);
    expect(behind([{ id: "unc" }], "unc")).toEqual([]);
    expect(behind(RING, null)).toEqual([]);
  });
});
