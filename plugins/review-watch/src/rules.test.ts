import { describe, expect, it } from "vitest";
import { classify, mergeQueue } from "./rules.js";
import { itemKey, type PullRequest, type QueueItem } from "./types.js";

const ME = "reader-ada";
const NOW = "2026-09-22T12:00:00Z";

/** Times ordered so a test can say "before my review" or "after the push". */
const T = {
  reviewed: "2026-09-20T09:00:00Z",
  pushed: "2026-09-21T09:00:00Z",
  commented: "2026-09-21T18:00:00Z",
};

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    nodeId: "PR_node1",
    repo: "inkwell/folio",
    number: 7,
    title: "Tighten the poller",
    url: "https://github.com/inkwell/folio/pull/7",
    author: "alice",
    isDraft: false,
    baseBranch: "main",
    headBranch: "alice/poller",
    headSha: "sha-head",
    headCommittedAt: T.pushed,
    updatedAt: T.commented,
    reviewDecision: "REVIEW_REQUIRED",
    changesRequestedAt: null,
    requestedReviewers: [],
    myLastReview: null,
    unresolvedThreads: [],
    ...overrides,
  };
}

function queueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  const rule = overrides.rule ?? "review-requested";
  const nodeId = overrides.nodeId ?? "PR_node1";
  const headSha = overrides.headSha ?? "sha-head";
  return {
    key: itemKey(rule, nodeId, headSha),
    rule,
    state: "queued",
    repo: "inkwell/folio",
    number: 7,
    title: "Tighten the poller",
    author: "alice",
    url: "https://github.com/inkwell/folio/pull/7",
    baseBranch: "main",
    headBranch: "alice/poller",
    headSha,
    nodeId,
    reason: "@alice requested your review",
    noticedAt: NOW,
    updatedAt: T.commented,
    ...overrides,
  };
}

function run(prs: PullRequest[], repoAllowlist: string[] = []): QueueItem[] {
  return classify(prs, { login: ME, repoAllowlist, now: NOW });
}

describe("classify: review-requested", () => {
  it("queues a pull request that names me as a reviewer so a request cannot go unseen", () => {
    const items = run([pullRequest({ requestedReviewers: [ME] })]);
    expect(items).toHaveLength(1);
    expect(items[0]?.rule).toBe("review-requested");
    expect(items[0]?.state).toBe("queued");
    expect(items[0]?.noticedAt).toBe(NOW);
    expect(items[0]?.reason).toBe("@alice requested your review");
    expect(items[0]?.key).toBe(itemKey("review-requested", "PR_node1", "sha-head"));
  });

  it("ignores a request on someone else's behalf, so a teammate's queue is not mine", () => {
    expect(run([pullRequest({ requestedReviewers: ["bob"] })])).toEqual([]);
  });

  it("stays quiet after I review the current head when no request remains", () => {
    const items = run([
      pullRequest({
        myLastReview: { state: "COMMENTED", submittedAt: T.commented },
      }),
    ]);
    expect(items).toEqual([]);
  });

  it("counts a request after an earlier review as follow-up work, not a new review", () => {
    const items = run([
      pullRequest({
        requestedReviewers: [ME],
        myLastReview: { state: "COMMENTED", submittedAt: T.reviewed },
      }),
    ]);
    expect(items.filter((item) => item.rule === "review-requested")).toHaveLength(0);
    expect(items.filter((item) => item.rule === "review-followup")).toHaveLength(1);
  });

  it("counts a same-head re-request after my review as follow-up work", () => {
    const items = run([
      pullRequest({
        requestedReviewers: [ME],
        myLastReview: { state: "COMMENTED", submittedAt: T.pushed },
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items.filter((item) => item.rule === "review-requested")).toHaveLength(0);
    expect(items.filter((item) => item.rule === "review-followup")).toHaveLength(1);
    expect(items[0]?.reason).toBe("@alice requested your follow-up review");
  });

  it("leaves drafts alone, because the author has not asked anyone to look yet", () => {
    expect(run([pullRequest({ requestedReviewers: [ME], isDraft: true })])).toEqual([]);
  });
});

describe("classify: review-followup", () => {
  it("queues a push that lands after my non-approving review, since my comments may be unanswered", () => {
    const items = run([
      pullRequest({ myLastReview: { state: "CHANGES_REQUESTED", submittedAt: T.reviewed } }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.rule).toBe("review-followup");
    expect(items[0]?.reason).toBe("@alice pushed a new commit since your review");
  });

  it("treats a push after my approval as someone else's problem", () => {
    const items = run([
      pullRequest({ myLastReview: { state: "APPROVED", submittedAt: T.reviewed } }),
    ]);
    expect(items).toEqual([]);
  });

  it("counts an explicit re-request after approval as follow-up work", () => {
    const items = run([
      pullRequest({
        requestedReviewers: [ME],
        myLastReview: { state: "APPROVED", submittedAt: T.reviewed },
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items.filter((item) => item.rule === "review-requested")).toHaveLength(0);
    expect(items.filter((item) => item.rule === "review-followup")).toHaveLength(1);
  });

  it("does not follow up after approval unless GitHub explicitly re-requests me", () => {
    const items = run([
      pullRequest({
        myLastReview: { state: "APPROVED", submittedAt: T.reviewed },
      }),
    ]);
    expect(items).toEqual([]);
  });

  it("stays quiet when nothing has been pushed since my review, so old reviews do not nag", () => {
    const items = run([
      pullRequest({ myLastReview: { state: "COMMENTED", submittedAt: T.commented } }),
    ]);
    expect(items).toEqual([]);
  });

  it("follows up after my review was dismissed, because a dismissal is not a sign-off", () => {
    const items = run([
      pullRequest({ myLastReview: { state: "DISMISSED", submittedAt: T.reviewed } }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.rule).toBe("review-followup");
  });

  it("does not follow up on a pull request I never reviewed, which is not mine to chase", () => {
    expect(run([pullRequest()])).toEqual([]);
  });

  it("leaves a draft alone even when I reviewed it before the push", () => {
    const items = run([
      pullRequest({
        isDraft: true,
        myLastReview: { state: "COMMENTED", submittedAt: T.reviewed },
      }),
    ]);
    expect(items).toEqual([]);
  });
});

describe("classify: feedback-to-address", () => {
  it("queues my own pull request when a reviewer asked for changes, so I answer the block", () => {
    const items = run([
      pullRequest({
        author: ME,
        reviewDecision: "CHANGES_REQUESTED",
        changesRequestedAt: T.commented,
        unresolvedThreads: [{ lastCommentAt: T.commented, author: "bob" }],
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.rule).toBe("feedback-to-address");
    expect(items[0]?.reason).toBe("changes requested by @bob");
  });

  it("names the blocking verdict even when no thread survives to attribute it", () => {
    const items = run([
      pullRequest({ author: ME, reviewDecision: "CHANGES_REQUESTED", changesRequestedAt: T.commented }),
    ]);
    expect(items[0]?.reason).toBe("changes requested on your pull request");
  });

  it("queues unresolved comments that arrived after my last push, since they await an answer", () => {
    const items = run([
      pullRequest({
        author: ME,
        unresolvedThreads: [
          { lastCommentAt: T.commented, author: "bob" },
          { lastCommentAt: T.commented, author: "carol" },
        ],
      }),
    ]);
    expect(items[0]?.rule).toBe("feedback-to-address");
    expect(items[0]?.reason).toBe("2 unresolved threads since your last push");
  });

  it("uses the singular for one thread, because the queue line is read by a human", () => {
    const items = run([
      pullRequest({ author: ME, unresolvedThreads: [{ lastCommentAt: T.commented, author: "bob" }] }),
    ]);
    expect(items[0]?.reason).toBe("1 unresolved thread since your last push");
  });

  it("goes quiet once I push over the feedback, so a fixed comment stops nagging", () => {
    const items = run([
      pullRequest({ author: ME, unresolvedThreads: [{ lastCommentAt: T.reviewed, author: "bob" }] }),
    ]);
    expect(items).toEqual([]);
  });

  it("treats a comment at the same instant as my push as already covered by it", () => {
    const items = run([
      pullRequest({ author: ME, unresolvedThreads: [{ lastCommentAt: T.pushed, author: "bob" }] }),
    ]);
    expect(items).toEqual([]);
  });

  it("ignores my own unresolved comments, because I am not waiting on myself", () => {
    const items = run([
      pullRequest({ author: ME, unresolvedThreads: [{ lastCommentAt: T.commented, author: ME }] }),
    ]);
    expect(items).toEqual([]);
  });

  it("still reports feedback on my own draft, which can carry comments like any other", () => {
    const items = run([
      pullRequest({
        author: ME,
        isDraft: true,
        unresolvedThreads: [{ lastCommentAt: T.commented, author: "bob" }],
      }),
    ]);
    expect(items[0]?.rule).toBe("feedback-to-address");
  });

  it("takes precedence over a review request when I am somehow author and reviewer", () => {
    const items = run([
      pullRequest({
        author: ME,
        requestedReviewers: [ME],
        reviewDecision: "CHANGES_REQUESTED",
        changesRequestedAt: T.commented,
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.rule).toBe("feedback-to-address");
  });

  it("does not fire on someone else's pull request with changes requested", () => {
    const items = run([
      pullRequest({ reviewDecision: "CHANGES_REQUESTED", changesRequestedAt: T.commented }),
    ]);
    expect(items).toEqual([]);
  });

  it("stays quiet on my approved pull request with nothing unresolved", () => {
    expect(run([pullRequest({ author: ME, reviewDecision: "APPROVED" })])).toEqual([]);
  });

  it("does not call my own later push a review follow-up", () => {
    const items = run([pullRequest({
      author: ME,
      myLastReview: { state: "COMMENTED", submittedAt: T.reviewed },
    })]);
    expect(items).toEqual([]);
  });

  it("does not re-queue my pull request after I push a fix the reviewer has not looked at yet", () => {
    // GitHub leaves reviewDecision at CHANGES_REQUESTED until Bob comes back, so
    // only the timestamps can tell that the ball is in his court, not mine.
    const items = run([
      pullRequest({
        author: ME,
        reviewDecision: "CHANGES_REQUESTED",
        changesRequestedAt: T.reviewed,
        unresolvedThreads: [{ lastCommentAt: T.reviewed, author: "bob" }],
      }),
    ]);
    expect(items).toEqual([]);
  });

  it("queues again when the reviewer requests changes on the new commit", () => {
    const items = run([
      pullRequest({
        author: ME,
        reviewDecision: "CHANGES_REQUESTED",
        changesRequestedAt: T.commented,
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.rule).toBe("feedback-to-address");
    expect(items[0]?.reason).toBe("changes requested on your pull request");
  });

  it("treats a changes-requested review at the same instant as my push as covered by it", () => {
    const items = run([
      pullRequest({
        author: ME,
        reviewDecision: "CHANGES_REQUESTED",
        changesRequestedAt: T.pushed,
      }),
    ]);
    expect(items).toEqual([]);
  });

  it("queues line comments left after my push even when no one has requested changes", () => {
    const items = run([
      pullRequest({
        author: ME,
        reviewDecision: "REVIEW_REQUIRED",
        changesRequestedAt: null,
        unresolvedThreads: [{ lastCommentAt: T.commented, author: "bob" }],
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.reason).toBe("1 unresolved thread since your last push");
  });

  it("prefers the changes-requested wording when the standing review is what fired", () => {
    const items = run([
      pullRequest({
        author: ME,
        reviewDecision: "CHANGES_REQUESTED",
        changesRequestedAt: T.commented,
        unresolvedThreads: [{ lastCommentAt: T.commented, author: "bob" }],
      }),
    ]);
    expect(items[0]?.reason).toBe("changes requested by @bob");
  });
});

describe("classify: repo allowlist", () => {
  it("watches every repo when the allowlist is empty, the unconfigured default", () => {
    expect(run([pullRequest({ requestedReviewers: [ME] })], [])).toHaveLength(1);
  });

  it("drops repos outside the allowlist, so an unrelated org cannot fill the queue", () => {
    const items = run([pullRequest({ requestedReviewers: [ME] })], ["inkwell/quill"]);
    expect(items).toEqual([]);
  });

  it("matches allowlist entries case-insensitively, because GitHub slugs are typed by hand", () => {
    const items = run([pullRequest({ requestedReviewers: [ME] })], ["Inkwell/Folio"]);
    expect(items).toHaveLength(1);
  });
});

describe("mergeQueue", () => {
  const open = (...nodeIds: string[]) => new Set(nodeIds);
  const merge = (
    existing: QueueItem[],
    incoming: QueueItem[],
    openNodeIds = open("PR_node1"),
    maxAgeDays = 14,
  ) => mergeQueue(existing, incoming, { openNodeIds, maxAgeDays, now: NOW });

  it("does not re-queue a dismissed item when the same head commit is seen again", () => {
    const stored = queueItem({ state: "dismissed", noticedAt: T.reviewed });
    const merged = merge([stored], [queueItem()]);
    expect(merged).toEqual([stored]);
  });

  it("keeps a started item's thread and noticedAt instead of resetting it to queued", () => {
    const stored = queueItem({ state: "started", threadId: "thread-9", noticedAt: T.reviewed });
    const merged = merge([stored], [queueItem()]);
    expect(merged).toEqual([stored]);
  });

  it("appends an item the queue has never seen, so new work actually shows up", () => {
    const incoming = queueItem({ rule: "review-followup" });
    expect(merge([], [incoming])).toEqual([incoming]);
  });

  it("drops an item whose pull request has merged or closed, since there is nothing to do", () => {
    const stored = queueItem({ state: "started" });
    expect(merge([stored], [], open())).toEqual([]);
  });

  it("drops a queued item the poll no longer justifies, so stale asks disappear", () => {
    expect(merge([queueItem()], [])).toEqual([]);
  });

  it("keeps a started item visible after GitHub stops reporting it", () => {
    const stored = queueItem({ state: "started", threadId: "thread-9" });
    expect(merge([stored], [])).toEqual([stored]);
  });

  it("keeps a dismissed item the poll no longer justifies, so it cannot come back", () => {
    const stored = queueItem({ state: "dismissed" });
    expect(merge([stored], [])).toEqual([stored]);
  });

  it("expires old queued rows but preserves decisions on open pull requests", () => {
    const old = { noticedAt: "2026-08-01T12:00:00Z" };
    const started = queueItem({ ...old, state: "started", rule: "review-followup" });
    const dismissed = queueItem({ ...old, state: "dismissed", rule: "feedback-to-address" });
    const merged = merge(
      [
        queueItem({ ...old, updatedAt: old.noticedAt, state: "queued" }),
        started,
        dismissed,
      ],
      [queueItem({ rule: "review-followup" }), queueItem({ rule: "feedback-to-address" })],
    );
    expect(merged).toEqual([dismissed, started]);
  });

  it("does not re-queue an expired open PR on the next poll", () => {
    const incoming = queueItem({ updatedAt: "2026-08-01T12:00:00Z" });
    const first = merge([], [incoming]);
    expect(first).toEqual([]);
    expect(merge(first, [incoming])).toEqual([]);
  });

  it("uses a fresh PR update when an existing queued row has the same key", () => {
    const old = queueItem({ noticedAt: "2026-08-01T12:00:00Z", updatedAt: "2026-08-01T12:00:00Z" });
    const incoming = queueItem({ updatedAt: T.commented });
    const first = merge([old], [incoming]);
    expect(first).toEqual([{ ...old, updatedAt: T.commented }]);
    expect(merge(first, [incoming])).toEqual(first);
  });

  it("keeps a PR updated exactly maxAgeDays ago, so the cutoff does not lose a live row", () => {
    const incoming = queueItem({ updatedAt: "2026-09-08T12:00:00Z" });
    expect(merge([], [incoming])).toEqual([incoming]);
  });

  it("sorts newest updatedAt first, so the freshest thing needing me is on top", () => {
    const older = queueItem({ nodeId: "PR_old", updatedAt: "2026-09-15T00:00:00Z" });
    const newer = queueItem({ nodeId: "PR_new", updatedAt: "2026-09-22T00:00:00Z" });
    const merged = merge([], [older, newer], open("PR_old", "PR_new"));
    expect(merged.map((item) => item.nodeId)).toEqual(["PR_new", "PR_old"]);
  });

  it("re-queues the same rule after a new push, because the key carries the head sha", () => {
    const stored = queueItem({ state: "dismissed" });
    const afterPush = queueItem({ headSha: "sha-newer" });
    const merged = merge([stored], [afterPush], open("PR_node1"));
    expect(merged.map((item) => item.state).sort()).toEqual(["dismissed", "queued"]);
  });
});
