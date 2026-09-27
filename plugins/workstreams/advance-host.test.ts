import { describe, expect, it } from "vitest";
import { advanceChecks, readAdvancePr, readEqualHeadTrees } from "./advance-host.js";
import { advanceInspectionSchema } from "./advance-contract.js";
import type { GhRunner } from "./ghactions.js";

const head = "a".repeat(40);
const base = "b".repeat(40);
const url = "https://github.com/example/widget/pull/42";
const view = {
  url, number: 42, title: "Fix account lookup", state: "OPEN", isDraft: false, isCrossRepository: false,
  headRefName: "fix-account", baseRefName: "main", headRefOid: head, baseRefOid: base,
  reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE",
  latestReviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
};

function fixture(options: { view?: Record<string, unknown>; review?: Record<string, unknown>; finalRefs?: Record<string, unknown>; bases?: unknown; views?: Record<string, unknown>[] } = {}) {
  let views = 0;
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push([...args]);
    let value: unknown;
    if (args[0] === "api") value = { data: { repository: { pullRequest: {
      headRefOid: head, baseRefOid: base, baseRefName: "main", baseRef: { name: "main", target: { oid: base } },
      reviews: { pageInfo: { hasPreviousPage: false }, nodes: [] },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
      ...(args.some((arg) => arg.includes("reviewThreads")) ? options.review : options.finalRefs),
    } } } };
    else if (args[1] === "list") value = options.bases ?? [];
    else { value = { ...view, ...options.view, ...options.views?.[views] }; views++; }
    return { ok: true, stdout: JSON.stringify(value) };
  };
  return { run, calls };
}

describe("bulk advance verification", () => {
  it("reuses identical commit trees only while the same open PR still has the expected head", async () => {
    const old = "c".repeat(40), fresh = "d".repeat(40), tree = "e".repeat(40);
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push([...args]);
      const sha = args.at(-1)!.split("/").at(-1)!;
      return { ok: true, stdout: JSON.stringify(args[0] === "api" ? { sha, tree: { sha: tree } } :
        { url, state: "OPEN", headRefOid: fresh }) };
    };
    expect(await readEqualHeadTrees(run, url, old, fresh)).toEqual({ ok: true, priorTreeOid: tree, currentTreeOid: tree });
    expect(calls.filter((args) => args[0] === "api")).toHaveLength(2);
    expect(await readEqualHeadTrees(run, url, old, fresh)).toMatchObject({ ok: true });
    expect(calls.filter((args) => args[0] === "api")).toHaveLength(2);
    expect(calls.filter((args) => args[1] === "view")).toHaveLength(2);
  });

  it("fails closed on a changed tree, incomplete commit read, or a head race", async () => {
    for (const [reason, oldDigit, freshDigit] of [["tree", "f", "1"], ["missing", "7", "8"], ["head", "9", "a"]] as const) {
      const old = oldDigit.repeat(40), fresh = freshDigit.repeat(40);
      const calls: string[][] = [];
      const run: GhRunner = async (args) => {
        calls.push([...args]);
        if (args[0] !== "api") return { ok: true, stdout: JSON.stringify({ url, state: "OPEN", headRefOid: reason === "head" ? old : fresh }) };
        const sha = args.at(-1)!.split("/").at(-1)!;
        return { ok: true, stdout: JSON.stringify(reason === "missing" ? {} : { sha,
          tree: { sha: sha === old ? "2".repeat(40) : reason === "tree" ? "3".repeat(40) : "2".repeat(40) } }) };
      };
      expect(await readEqualHeadTrees(run, url, old, fresh)).toEqual({ ok: false });
      expect(calls.filter((args) => args[0] === "api")).toHaveLength(2);
      expect(calls.filter((args) => args[1] === "view")).toHaveLength(reason === "head" ? 1 : 0);
    }
  });

  it("uses an enterprise host flag without putting the hostname in the REST repository path", async () => {
    const old = "4".repeat(40), fresh = "5".repeat(40), enterprise = "https://github.example.test/acme/widget/pull/42";
    const calls: string[][] = [];
    const run: GhRunner = async (args) => { calls.push([...args]);
      const sha = args.at(-1)!.split("/").at(-1)!;
      return { ok: true, stdout: JSON.stringify(args[0] === "api" ? { sha, tree: { sha: "6".repeat(40) } } :
        { url: enterprise, state: "OPEN", headRefOid: fresh }) };
    };
    expect(await readEqualHeadTrees(run, enterprise, old, fresh)).toMatchObject({ ok: true });
    expect(calls.filter((args) => args[0] === "api")).toEqual([
      ["api", "--hostname", "github.example.test", `repos/acme/widget/git/commits/${old}`],
      ["api", "--hostname", "github.example.test", `repos/acme/widget/git/commits/${fresh}`],
    ]);
  });
  it.each(["MERGED", "CLOSED"] as const)("recognizes %s without review reads or surviving branch refs", async (state) => {
    const fake = fixture({ view: { state, headRefName: null, headRefOid: null, baseRefName: null, latestReviews: null, statusCheckRollup: null } });
    const result = await readAdvancePr(fake.run, url);
    expect(result).toMatchObject({ ok: true, facts: { state, readiness: state.toLowerCase(), needsPreparation: false, baseOid: "", headOid: "" } });
    expect(advanceInspectionSchema.safeParse(result).success).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });
  it("requires commit identities in open inspection contracts", async () => {
    const result = await readAdvancePr(fixture().run, url);
    if (!result.ok) throw new Error(result.error);
    expect(advanceInspectionSchema.safeParse({ ...result, facts: { ...result.facts, baseOid: "" } }).success).toBe(false);
  });
  it("still validates the identity of completed PR responses", async () => {
    expect(await readAdvancePr(fixture({ view: { state: "MERGED", number: 43 } }).run, url)).toMatchObject({ ok: false, error: "GitHub returned a different pull request." });
  });

  it("calls a PR ready only after approval, feedback, checks, stack, and commit identities agree", async () => {
    const result = await readAdvancePr(fixture().run, url);
    expect(result).toMatchObject({ ok: true, facts: { readiness: "ready", headOid: head, baseOid: base, needsPreparation: false } });
  });

  it("keeps approved comments as attention even after the branch is mergeable", async () => {
    const result = await readAdvancePr(fixture({ review: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: false }] } } }).run, url);
    expect(result).toMatchObject({ ok: true, facts: { readiness: "needs-attention", unresolvedThreads: 1 } });
  });

  it("prepares a blocked approved PR without claiming its comments have been addressed", async () => {
    const result = await readAdvancePr(fixture({ view: { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" }, review: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: false }] } } }).run, url);
    expect(result).toMatchObject({ ok: true, facts: { needsPreparation: true, readiness: "needs-attention", unresolvedThreads: 1 } });
  });

  it("passes written approval feedback to the persisted-record gate independently of base readiness", async () => {
    const review = { id: "approval-1", state: "APPROVED", body: "Fix the fallback", author: { login: "reviewer" },
      submittedAt: "2026-09-24T12:00:00Z", commit: { oid: head } };
    const result = await readAdvancePr(fixture({
      view: { latestReviews: [{ state: "APPROVED", body: review.body }] },
      review: { reviews: { pageInfo: { hasPreviousPage: false }, nodes: [review] } },
    }).run, url);
    expect(result).toMatchObject({ ok: true, facts: { readiness: "ready",
      approvalFeedback: { status: "present", sourceIds: ["approval-1"] } } });
  });

  it("leaves empty pending conclusions waiting, and distinguishes lost approval", async () => {
    expect(await readAdvancePr(fixture({ view: { statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: "" }] } }).run, url))
      .toMatchObject({ ok: true, facts: { readiness: "waiting-checks", checks: "pending" } });
    expect(await readAdvancePr(fixture({ view: { reviewDecision: "REVIEW_REQUIRED" } }).run, url))
      .toMatchObject({ ok: true, facts: { readiness: "waiting-review" } });
  });

  it("keeps failed checks actionable before approval and leaves a clean draft for its author to finish", async () => {
    expect(await readAdvancePr(fixture({ view: { reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] } }).run, url))
      .toMatchObject({ ok: true, facts: { readiness: "needs-attention", checks: "failed", detail: "One or more checks failed." } });
    expect(await readAdvancePr(fixture({ view: { isDraft: true, reviewDecision: null } }).run, url))
      .toMatchObject({ ok: true, facts: { isDraft: true, readiness: "needs-attention", detail: expect.stringContaining("mark it ready") } });
    expect(await readAdvancePr(fixture({ view: { isDraft: true, reviewDecision: null, statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: "" }] } }).run, url))
      .toMatchObject({ ok: true, facts: { isDraft: true, readiness: "waiting-checks", checks: "pending" } });
  });

  it("recognizes verified author follow-up to a changes request without inline threads", async () => {
    const review = { id: "requested", state: "CHANGES_REQUESTED", body: "Check the fallback", author: { login: "reviewer" }, submittedAt: "2026-09-18T17:00:00Z", commit: { oid: "c".repeat(40) } };
    const reviewFacts = {
      reviews: { pageInfo: { hasPreviousPage: false }, nodes: [review] },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
      author: { login: "author" },
      commits: { nodes: [{ commit: { oid: head, committedDate: "2026-09-19T12:00:00Z" } }] },
      comments: { nodes: [{ author: { login: "author" }, createdAt: "2026-09-20T12:00:00Z", body: "PTAL @reviewer — updated the fallback." }] },
    };
    const pending = { view: { reviewDecision: "CHANGES_REQUESTED", latestReviews: [{ state: "CHANGES_REQUESTED", body: "Check the fallback" }] }, review: reviewFacts };
    expect(await readAdvancePr(fixture(pending).run, url))
      .toMatchObject({ ok: true, facts: { reviewFollowupPosted: true, readiness: "waiting-review" } });
    expect(await readAdvancePr(fixture({ ...pending, review: { ...reviewFacts, comments: { nodes: [] } } }).run, url))
      .toMatchObject({ ok: true, facts: { reviewFollowupPosted: false, readiness: "needs-attention", detail: expect.stringContaining("without a verified author follow-up") } });
  });

  it("refuses readiness when approval history or check data is incomplete", async () => {
    expect(await readAdvancePr(fixture({ review: { reviews: { pageInfo: { hasPreviousPage: true }, nodes: [] } } }).run, url))
      .toMatchObject({ ok: true, facts: { approvalFeedback: { status: "unknown" } } });
    expect(await readAdvancePr(fixture({ view: { statusCheckRollup: [{}] } }).run, url))
      .toMatchObject({ ok: true, facts: { readiness: "needs-attention" } });
    expect(await readAdvancePr(fixture({ review: { reviewThreads: { pageInfo: { hasNextPage: true }, nodes: [] } } }).run, url)).toMatchObject({ ok: false });
  });

  it("reports a live open base PR as a dependency even when all checks pass", async () => {
    expect(await readAdvancePr(fixture({ bases: [{ number: 41, headRefName: "main" }] }).run, url))
      .toMatchObject({ ok: true, facts: { basePrNumber: 41, readiness: "needs-attention" } });
  });

  it("retries a head change and accepts only the coherent second attempt", async () => {
    const fake = fixture({ views: [{ headRefOid: "c".repeat(40) }] });
    expect(await readAdvancePr(fake.run, url)).toMatchObject({ ok: true, facts: { headOid: head } });
    expect(fake.calls.filter((args) => args[1] === "view")).toHaveLength(4);
  });

  it("fails boundedly if review facts describe an old head or base", async () => {
    for (const review of [{ headRefOid: "c".repeat(40) }, { baseRef: { name: "main", target: { oid: "c".repeat(40) } } }]) {
      const fake = fixture({ review });
      expect(await readAdvancePr(fake.run, url)).toMatchObject({ ok: false, error: expect.stringContaining("changed during verification") });
      expect(fake.calls.filter((args) => args[1] === "view")).toHaveLength(6);
    }
  });

  it("allows read-only verification of an already ready fork", async () => {
    expect(await readAdvancePr(fixture({ view: { isCrossRepository: true } }).run, url)).toMatchObject({ ok: true, facts: { readiness: "ready" } });
  });

  it("rejects partial API results and ambiguous base branches", async () => {
    expect(await readAdvancePr(fixture({ finalRefs: { baseRef: null } }).run, url)).toMatchObject({ ok: false });
    expect(await readAdvancePr(fixture({ bases: [{ number: 40, headRefName: "main" }, { number: 41, headRefName: "main" }] }).run, url)).toMatchObject({ ok: false });
  });

  it("uses the current base ref when the PR's historical base snapshot is stale", async () => {
    const stale = "c".repeat(40);
    expect(await readAdvancePr(fixture({ view: { baseRefOid: stale }, review: { baseRefOid: stale } }).run, url))
      .toMatchObject({ ok: true, facts: { baseOid: base, readiness: "ready" } });
  });

  it("refuses readiness when the actual base branch moves during verification", async () => {
    const fake = fixture({ finalRefs: { baseRef: { name: "main", target: { oid: "c".repeat(40) } } } });
    expect(await readAdvancePr(fake.run, url)).toMatchObject({ ok: false, error: expect.stringContaining("changed during verification") });
    expect(fake.calls.filter((args) => args[1] === "view")).toHaveLength(6);
  });
});

describe("advance checks", () => {
  it("fails closed for unknown states while permitting explicit skipped and neutral checks", () => {
    expect(advanceChecks([{ status: "COMPLETED", conclusion: "NEUTRAL" }, { status: "COMPLETED", conclusion: "SKIPPED" }])).toBe("passed");
    expect(advanceChecks([{ status: "NEW_STATE", conclusion: "SUCCESS" }])).toBe("unknown");
    expect(advanceChecks([{ state: "FAILURE" }])).toBe("failed");
    expect(advanceChecks([{ state: "PENDING" }])).toBe("pending");
  });
});
