import type { PipelineCard } from "./pipeline";
import { advancePrKey } from "./bulk-advance-selection";
import { canonicalPrUrl } from "./pr-holds";

export const CONVERSATION_SCOPE_LIMIT = 100;

export type SeenConversationProposal = { initialized: boolean; revision: number };

/** A reopened proposal needs manual review; a later revision gets one automatic check. */
export function observeConversationProposal(
  seen: SeenConversationProposal,
  proposal: { revision: number; selectedPrUrls: readonly string[] } | null,
): { seen: SeenConversationProposal; autoPreviewRevision: number | null } {
  if (!seen.initialized) return {
    seen: { initialized: true, revision: proposal?.revision ?? 0 },
    autoPreviewRevision: null,
  };
  if (!proposal || proposal.revision <= seen.revision) return { seen, autoPreviewRevision: null };
  return {
    seen: { initialized: true, revision: proposal.revision },
    autoPreviewRevision: proposal.selectedPrUrls.length ? proposal.revision : null,
  };
}

export type ConversationScope = {
  prUrls: string[];
  heldExcluded: number;
  branchesIgnored: number;
  unavailableSelected: number;
  label: string;
};

const key = (url: string): string => advancePrKey(canonicalPrUrl(url) ?? url);

/** Capture the exact PRs behind a Work on these action before filters can change. */
export function conversationScope(
  allCards: readonly PipelineCard[],
  visibleCards: readonly PipelineCard[],
  selectedUrls: readonly string[],
  label?: string,
): ConversationScope {
  const selected = selectedUrls.length > 0;
  const selectedKeys = [...new Set(selectedUrls.map(key))];
  const source = selected
    ? allCards.filter((card) => card.pr && selectedKeys.includes(key(card.pr.url)))
    : visibleCards;
  const seen = new Set<string>();
  const prUrls: string[] = [];
  let heldExcluded = 0;
  for (const card of source) {
    if (card.pr?.state !== "OPEN") continue;
    const url = key(card.pr.url);
    if (seen.has(url)) continue;
    seen.add(url);
    if (card.hold) heldExcluded++;
    prUrls.push(url);
  }
  return {
    prUrls,
    heldExcluded,
    branchesIgnored: source.filter((card) => card.pr === null).length,
    unavailableSelected: selected
      ? selectedKeys.filter((url) => !source.some((card) => card.pr?.state === "OPEN" && key(card.pr.url) === url)).length
      : 0,
    label: label ?? (selected ? "Selected PRs" : "Matching PRs"),
  };
}
