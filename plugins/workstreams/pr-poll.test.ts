import { describe, expect, it } from "vitest";
import { createPrPoll } from "./pr-poll.js";

describe("visible PR polling", () => {
  it("coalesces concurrent views behind one cadence", () => {
    let now = 0;
    const poll = createPrPoll({ now: () => now, intervalMs: 45_000, batchSize: 20 });
    expect(poll.select(["a", "b"], [])).toEqual(["a", "b"]);
    expect(poll.select(["a", "b"], [])).toEqual([]);
    now = 44_999;
    expect(poll.select(["a", "b"], [])).toEqual([]);
    now++;
    expect(poll.select(["a", "b"], [])).toEqual(["a", "b"]);
  });

  it("rotates ordinary PRs even when priority work fills its allowance", () => {
    let now = 0;
    const poll = createPrPoll({ now: () => now, intervalMs: 45_000, batchSize: 4 });
    const urls = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const selected = Array.from({ length: 3 }, () => {
      const batch = poll.select(urls, ["a", "b", "c"]);
      now += 45_000;
      return batch;
    });
    expect(selected.map((batch) => batch.slice(0, 2))).toEqual([["a", "b"], ["c", "a"], ["b", "c"]]);
    expect(new Set(selected.flat())).toEqual(new Set(urls));
  });
});
