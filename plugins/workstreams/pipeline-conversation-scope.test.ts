import { describe, expect, it } from "vitest";
import type { PipelineCard } from "./pipeline";
import { conversationScope, observeConversationProposal } from "./pipeline-conversation-scope";

function card(number: number, options: { state?: string; held?: boolean; stage?: PipelineCard["stage"] } = {}): PipelineCard {
  return {
    key: `pr-${number}`,
    pr: { url: `https://github.com/example/repo/pull/${number}`, state: options.state ?? "OPEN" },
    hold: options.held ? { reason: "Waiting for review", heldAt: 1 } : null,
    stage: options.stage ?? "feedback",
  } as PipelineCard;
}
const branch = { key: "branch-only", pr: null, stage: "build" } as PipelineCard;

describe("work conversation scope", () => {
  it("captures every matching open PR, including held PRs, while ignoring branch-only cards", () => {
    const cards = [card(1), card(2, { held: true }), card(3, { state: "MERGED" }), branch];
    expect(conversationScope(cards, cards, [])).toEqual({
      prUrls: ["https://github.com/example/repo/pull/1", "https://github.com/example/repo/pull/2"],
      heldExcluded: 1,
      branchesIgnored: 1,
      unavailableSelected: 0,
      label: "Matching PRs",
    });
  });

  it("uses selected PRs even when search hides them and does not add matching PRs", () => {
    const cards = [card(1), card(2), card(3)];
    expect(conversationScope(cards, [cards[2]!], [cards[0]!.pr!.url, cards[1]!.pr!.url])).toMatchObject({
      prUrls: [cards[0]!.pr!.url, cards[1]!.pr!.url],
      label: "Selected PRs",
    });
  });

  it("captures a stage entry from current filtered cards, including held Feedback", () => {
    const cards = [card(1, { stage: "build" }), card(2), card(3, { held: true }), branch];
    expect(conversationScope(cards, cards.filter((item) => item.stage === "feedback"), [], "Feedback")).toMatchObject({
      prUrls: [cards[1]!.pr!.url, cards[2]!.pr!.url],
      heldExcluded: 1,
      label: "Feedback",
    });
  });

  it("flags selected PRs that disappeared or closed instead of silently narrowing scope", () => {
    const cards = [card(1), card(2, { state: "CLOSED" })];
    expect(conversationScope(cards, cards, [cards[0]!.pr!.url, cards[1]!.pr!.url, "https://github.com/example/repo/pull/9"])).toMatchObject({
      prUrls: [cards[0]!.pr!.url],
      unavailableSelected: 2,
    });
  });
});

describe("conversation proposal preview", () => {
  it("does not recheck a proposal when the conversation is reopened", () => {
    const first = observeConversationProposal({ initialized: false, revision: 0 }, { revision: 4, selectedPrUrls: ["pr"] });
    expect(first.autoPreviewRevision).toBeNull();
    expect(observeConversationProposal(first.seen, { revision: 4, selectedPrUrls: ["pr"] }).autoPreviewRevision).toBeNull();
  });

  it("checks a new nonempty revision once despite repeated board updates", () => {
    const baseline = observeConversationProposal({ initialized: false, revision: 0 }, null);
    const proposed = observeConversationProposal(baseline.seen, { revision: 1, selectedPrUrls: ["pr"] });
    expect(proposed.autoPreviewRevision).toBe(1);
    expect(observeConversationProposal(proposed.seen, { revision: 1, selectedPrUrls: ["pr"] }).autoPreviewRevision).toBeNull();
    expect(observeConversationProposal(proposed.seen, { revision: 2, selectedPrUrls: [] }).autoPreviewRevision).toBeNull();
  });
});
