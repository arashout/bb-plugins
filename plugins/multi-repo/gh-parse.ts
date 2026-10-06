/**
 * `gh --json` field selection and normalizers.
 *
 * Modeled on bb's own `packages/host-workspace/src/git-host.ts` — read, not
 * imported: that package is private to bb. The field list and the shape of
 * each normalizer match it so a PR reads the same here as in bb's native PR
 * surface, and so the same GitHub quirks are handled the same way.
 *
 * Every normalizer is total. `gh` is a separate binary on a version this
 * plugin does not control, and GitHub adds enum values; a field this code has
 * never seen must degrade to "unknown" rather than throw away the whole PR.
 *
 * Pure: no process spawning, so the parsing is testable against captured
 * fixtures.
 */
import type { PullRequest } from "./contract.js";

/** The `--json` field list. Kept in the order bb lists them for easy diffing. */
export const PR_FIELDS = [
  "number",
  "title",
  "state",
  "url",
  "isDraft",
  "baseRefName",
  "headRefName",
  "updatedAt",
  "statusCheckRollup",
  "reviewDecision",
  "reviewRequests",
  "mergeStateStatus",
  "mergeable",
].join(",");

/**
 * GitHub's authoritative "can this merge right now" signal. `CLEAN`,
 * `HAS_HOOKS` and `UNSTABLE` all mean nothing blocks the button; `BEHIND`
 * needs an update; `BLOCKED` is unsatisfied branch protection; `DIRTY` is a
 * conflict. `UNKNOWN` covers a value GitHub has not computed yet or one added
 * after this was written.
 */
export const MERGE_STATE_STATUSES = [
  "CLEAN",
  "BEHIND",
  "DIRTY",
  "BLOCKED",
  "UNSTABLE",
  "HAS_HOOKS",
  "UNKNOWN",
] as const;

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function getBoolean(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true;
}

function getNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeUppercase(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value.toUpperCase().slice(0, 40) : null;
}

export function normalizeMergeStateStatus(value: unknown): string {
  const upper = normalizeUppercase(value);
  return upper !== null && (MERGE_STATE_STATUSES as readonly string[]).includes(upper) ? upper : "UNKNOWN";
}

export function normalizeReviewDecision(value: unknown): string | null {
  return normalizeUppercase(value);
}

export function normalizeMergeable(value: unknown): string | null {
  return normalizeUppercase(value);
}

/**
 * Flatten `statusCheckRollup` into name/conclusion pairs.
 *
 * The rollup mixes two shapes: GitHub Actions check runs carry `conclusion`
 * and a `name`, while third-party commit statuses carry `state` and a
 * `context`. Both are checks to a person looking at the panel, so both are
 * read here rather than only the first.
 */
export function normalizeChecks(value: unknown): PullRequest["checks"] {
  if (!Array.isArray(value)) return [];
  const checks: PullRequest["checks"] = [];
  for (const item of value.slice(0, 100)) {
    const object = asObject(item);
    if (object === null) continue;
    const name =
      getString(object, "name") ||
      getString(object, "context") ||
      getString(object, "workflowName") ||
      "check";
    checks.push({
      name: name.slice(0, 200),
      conclusion: normalizeUppercase(object.conclusion) ?? normalizeUppercase(object.state),
    });
  }
  return checks;
}

/** A check is still running when it has no conclusion yet. */
export function checkSummary(checks: PullRequest["checks"]): {
  passed: number;
  failed: number;
  pending: number;
} {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const check of checks) {
    if (check.conclusion === null) pending += 1;
    else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion)) passed += 1;
    else if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE"].includes(check.conclusion))
      failed += 1;
    else pending += 1;
  }
  return { passed, failed, pending };
}

export function normalizePullRequest(json: unknown): PullRequest | null {
  const object = asObject(json);
  if (object === null) return null;
  const number = getNumber(object, "number");
  if (number <= 0) return null;
  return {
    number,
    title: getString(object, "title").slice(0, 400),
    url: getString(object, "url").slice(0, 600),
    state: normalizeUppercase(object.state) ?? "UNKNOWN",
    isDraft: getBoolean(object, "isDraft"),
    baseRefName: getString(object, "baseRefName").slice(0, 300),
    headRefName: getString(object, "headRefName").slice(0, 300),
    reviewDecision: normalizeReviewDecision(object.reviewDecision),
    mergeStateStatus: normalizeMergeStateStatus(object.mergeStateStatus),
    mergeable: normalizeMergeable(object.mergeable),
    checks: normalizeChecks(object.statusCheckRollup),
    reviewRequestCount: Array.isArray(object.reviewRequests) ? object.reviewRequests.length : 0,
  };
}

/**
 * Pick the PR a branch's panel should show.
 *
 * An open PR always wins, however old. A branch whose PR was closed and
 * reopened as a new one, or merged and then worked on again, otherwise shows
 * the stale entry — and "merged" on a branch that is actively being changed is
 * the single most misleading thing this panel could say.
 */
export function parsePrList(stdout: string): PullRequest | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(json)) return null;
  const parsed = json.map(normalizePullRequest).filter((pr): pr is PullRequest => pr !== null);
  return parsed.find((pr) => pr.state === "OPEN") ?? parsed[0] ?? null;
}

/** The URL `gh pr create` prints on success, for linking straight to it. */
export function parseCreatedUrl(stdout: string): string | null {
  const match = /(https:\/\/\S+\/pull\/\d+)/u.exec(stdout);
  return match === null ? null : match[1];
}
