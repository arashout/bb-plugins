import { describe, expect, it } from "vitest";
import { checkCounts, checksFailed, checksGreen } from "./pr-checks.js";

describe("scanned PR checks", () => {
  it.each(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"])(
    "marks %s as failed even alongside passing checks",
    (conclusion) => {
      expect(checksFailed(["SUCCESS", conclusion])).toBe(true);
      expect(checksGreen(["SUCCESS", conclusion])).toBe(false);
    },
  );

  it.each(["PENDING", "IN_PROGRESS", "STALE", "UNKNOWN"])(
    "never treats %s as green or a confirmed failure",
    (conclusion) => {
      expect(checksFailed([conclusion])).toBe(false);
      expect(checksGreen([conclusion])).toBe(false);
    },
  );

  it("accepts completed passing checks and repositories without checks", () => {
    expect(checksGreen(["SUCCESS", "NEUTRAL", "SKIPPED"])).toBe(true);
    expect(checksGreen([])).toBe(true);
    expect(checksFailed([])).toBe(false);
  });

  it("counts a check still running as not done, so a CI chip never reads finished while one runs", () => {
    // Seven of nine done, one of them failed: in-progress and unknown results are neither.
    expect(checkCounts(["SUCCESS", "SUCCESS", "NEUTRAL", "SKIPPED", "SUCCESS", "FAILURE", "SUCCESS", "PENDING", "UNKNOWN"])).toEqual({ done: 7, total: 9, failed: 1 });
    expect(checkCounts([])).toEqual({ done: 0, total: 0, failed: 0 });
  });
});
