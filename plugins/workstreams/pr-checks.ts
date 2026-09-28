/** Check conclusions from a scan. Unknown results are neither green nor a repair signal. */
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const GREEN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

export function checksFailed(conclusions: readonly string[]): boolean {
  return conclusions.some((value) => FAILED.has(value));
}

/** An empty rollup is green because some repositories run no checks. */
export function checksGreen(conclusions: readonly string[]): boolean {
  return conclusions.every((value) => GREEN.has(value));
}

/** How many checks finished and how many of those failed; an in-progress or unknown result isn't done. */
export function checkCounts(conclusions: readonly string[]): { done: number; total: number; failed: number } {
  return { done: conclusions.filter((value) => FAILED.has(value) || GREEN.has(value)).length, total: conclusions.length,
    failed: conclusions.filter((value) => FAILED.has(value)).length };
}
