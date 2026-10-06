import { describe, expect, it } from "vitest";
import {
  PR_FIELDS,
  checkSummary,
  normalizeChecks,
  normalizeMergeStateStatus,
  normalizePullRequest,
  parseCreatedUrl,
  parsePrList,
} from "./gh-parse.js";

const prJson = {
  number: 42,
  title: "Fix the thing",
  state: "open",
  url: "https://github.com/you/repo/pull/42",
  isDraft: false,
  baseRefName: "main",
  headRefName: "dylan/fix",
  updatedAt: "2026-09-29T00:00:00Z",
  reviewDecision: "approved",
  mergeStateStatus: "clean",
  mergeable: "mergeable",
  reviewRequests: [{ login: "a" }, { login: "b" }],
  statusCheckRollup: [
    { name: "build", conclusion: "SUCCESS", status: "COMPLETED" },
    { context: "legacy-ci", state: "failure" },
    { name: "slow", conclusion: null, status: "IN_PROGRESS" },
  ],
};

describe("PR_FIELDS", () => {
  it("asks for the fields the panel actually renders", () => {
    for (const field of ["number", "statusCheckRollup", "reviewDecision", "mergeStateStatus", "isDraft"]) {
      expect(PR_FIELDS).toContain(field);
    }
  });
});

describe("normalizePullRequest", () => {
  it("uppercases the enums GitHub returns in mixed case", () => {
    const pr = normalizePullRequest(prJson);
    expect(pr?.state).toBe("OPEN");
    expect(pr?.reviewDecision).toBe("APPROVED");
    expect(pr?.mergeStateStatus).toBe("CLEAN");
  });

  it("counts requested reviewers without keeping their identities", () => {
    expect(normalizePullRequest(prJson)?.reviewRequestCount).toBe(2);
  });

  it("returns null for something that is not a PR", () => {
    expect(normalizePullRequest(null)).toBeNull();
    expect(normalizePullRequest({ title: "no number" })).toBeNull();
    expect(normalizePullRequest("nope")).toBeNull();
  });

  it("survives every field being absent", () => {
    const pr = normalizePullRequest({ number: 1 });
    expect(pr).not.toBeNull();
    expect(pr?.checks).toEqual([]);
    expect(pr?.reviewDecision).toBeNull();
    expect(pr?.mergeStateStatus).toBe("UNKNOWN");
  });
});

describe("normalizeMergeStateStatus", () => {
  it("passes through the values GitHub documents", () => {
    expect(normalizeMergeStateStatus("BEHIND")).toBe("BEHIND");
    expect(normalizeMergeStateStatus("dirty")).toBe("DIRTY");
  });

  it("degrades an unrecognized value to UNKNOWN rather than trusting it", () => {
    // GitHub adds enum values; UNKNOWN is never read as ready to merge.
    expect(normalizeMergeStateStatus("SOMETHING_NEW")).toBe("UNKNOWN");
    expect(normalizeMergeStateStatus(undefined)).toBe("UNKNOWN");
  });
});

describe("normalizeChecks", () => {
  it("reads both check runs and legacy commit statuses", () => {
    const checks = normalizeChecks(prJson.statusCheckRollup);
    expect(checks.map((check) => check.name)).toEqual(["build", "legacy-ci", "slow"]);
    expect(checks[1].conclusion).toBe("FAILURE");
  });

  it("reports a running check as no conclusion, not as a pass", () => {
    expect(normalizeChecks(prJson.statusCheckRollup)[2].conclusion).toBeNull();
  });

  it("returns nothing for a missing rollup", () => {
    expect(normalizeChecks(undefined)).toEqual([]);
  });
});

describe("checkSummary", () => {
  it("counts passes, failures and still-running checks", () => {
    expect(checkSummary(normalizeChecks(prJson.statusCheckRollup))).toEqual({ passed: 1, failed: 1, pending: 1 });
  });

  it("treats skipped and neutral as passing", () => {
    expect(checkSummary([{ name: "a", conclusion: "SKIPPED" }, { name: "b", conclusion: "NEUTRAL" }]).passed).toBe(2);
  });
});

describe("parsePrList", () => {
  it("prefers an open PR over a stale merged one for the same branch", () => {
    const stdout = JSON.stringify([
      { ...prJson, number: 1, state: "MERGED" },
      { ...prJson, number: 2, state: "OPEN" },
    ]);
    expect(parsePrList(stdout)?.number).toBe(2);
  });

  it("falls back to the first entry when none is open", () => {
    const stdout = JSON.stringify([{ ...prJson, number: 7, state: "CLOSED" }]);
    expect(parsePrList(stdout)?.number).toBe(7);
  });

  it("returns null for no PRs and for junk", () => {
    expect(parsePrList("[]")).toBeNull();
    expect(parsePrList("not json")).toBeNull();
    expect(parsePrList('{"not":"an array"}')).toBeNull();
  });
});

describe("parseCreatedUrl", () => {
  it("finds the URL gh prints on success", () => {
    expect(parseCreatedUrl("https://github.com/you/repo/pull/99\n")).toBe("https://github.com/you/repo/pull/99");
  });

  it("returns null when there is nothing to link to", () => {
    expect(parseCreatedUrl("Creating pull request...")).toBeNull();
  });
});
