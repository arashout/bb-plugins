import { prHoldFor, type PrHold, type PrHolds } from "./pr-holds.js";
import type { Pr } from "./contract.js";
import type { Row } from "./inbox-rows.js";
import { primaryAction, type PrimaryAction } from "./actions.js";
import { displayTitle, inboxSection, inboxVerb, prLifecycle, unitLifecycle, type InboxSection, type Lifecycle } from "./workstreams.js";
import { prWorkItemKey, workItemIndex } from "./work-item-index.js";

export const BACKLOG_GROUPS = ["ready", "approved", "respond", "waiting", "draft", "unknown", "held"] as const;
export type BacklogGroup = (typeof BACKLOG_GROUPS)[number];
export type BacklogEntry = { repo: string; pr: Pr; stale: boolean; effortKey?: string; effortName?: string };
export type BacklogRow = BacklogEntry & {
  hold?: PrHold | null; group: BacklogGroup; lifecycle: Lifecycle; section: InboxSection; verb: string; action: PrimaryAction | null; local: Row | null;
  parent: { repo: string; pr: Pr } | null;
};
/** The open PR an entry is stacked on: another in its repository whose head branch is the entry's base. */
export function stackParent<T extends { repo: string; pr: Pick<Pr, "number" | "baseRefName" | "headRefName"> }>(entry: T, open: readonly T[]): T | null {
  const { pr } = entry;
  return pr.baseRefName === null ? null : open.find((candidate) =>
    candidate.repo.toLowerCase() === entry.repo.toLowerCase() && candidate.pr.number !== pr.number && candidate.pr.headRefName === pr.baseRefName,
  ) ?? null;
}

/** Inventory owns membership and remote facts; a real checkout only adds local context. */
export function prBacklog(entries: readonly BacklogEntry[], locals: readonly Row[], now: number, holds: PrHolds = {}): BacklogRow[] {
  // A rebase in any checkout must not disappear behind a second clean checkout.
  const sortedLocals = [...locals].sort((a, b) => Number(b.unit.rebasing === true) - Number(a.unit.rebasing === true) || a.key.localeCompare(b.key));
  const items = workItemIndex(entries.filter((entry) => entry.pr.state === "OPEN").map((entry) => ({ url: entry.pr.url, stale: entry.stale, value: entry })),
    sortedLocals.flatMap((row) => row.unit.pr === null ? [] : [{ url: row.unit.pr.url, path: row.key,
      tickets: row.unit.ticket ? [row.unit.ticket] : [], value: row }]));
  const unique = [...items.values()].flatMap((item) => item.remote ? [item.remote] : []);
  const result = unique.map((entry): BacklogRow => {
    const { pr } = entry;
    const hold = prHoldFor(pr.url, holds);
    const original = items.get(prWorkItemKey(pr.url))?.locals[0] ?? null;
    const parent = stackParent(entry, unique);
    const lifecycle = original === null ? prLifecycle(pr) : unitLifecycle({ ...original.unit, pr });
    const stack = parent === null ? original?.unit.stack ?? null : { blockedBelow: parent.pr.number };
    const facts = { ticket: original?.unit.ticket ?? null, pr, lifecycle, stack, rebasing: original?.unit.rebasing };
    const section = inboxSection(facts, now);
    const currentVerb = inboxVerb(facts, section) ?? "In progress";
    // Approval still stands while CI runs; nudging a reviewer cannot clear CI.
    const verb = entry.stale ? "Refresh to verify" : pr.reviewDecision === "APPROVED" && currentVerb === "In review" ? "Checks pending" : currentVerb;
    const action = entry.stale ? null : primaryAction(facts, section, verb);
    const local = original === null ? null : {
      ...original, unit: { ...original.unit, pr, lifecycle, stack: parent === null ? original.unit.stack : { ...original.unit.stack, id: original.unit.stack?.id ?? parent.pr.url, blockedBelow: parent.pr.number, size: original.unit.stack?.size ?? 2, position: original.unit.stack?.position ?? 2 } },
      title: displayTitle(pr.title), section, verb, action, hold,
    };
    const group: BacklogGroup = hold !== null ? "held" : entry.stale || lifecycle === "unverified" ? "unknown"
      : pr.isDraft || original?.unit.rebasing ? "draft"
      : stack?.blockedBelow != null ? "waiting"
      : verb === "Ready to merge" ? "ready"
      : pr.reviewDecision === "APPROVED" ? "approved"
      : section === "fix" || section === "respond" ? "respond" : "waiting";
    return { ...entry, hold, group, lifecycle, section, verb, action, local, parent };
  });
  return result.sort((a, b) => BACKLOG_GROUPS.indexOf(a.group) - BACKLOG_GROUPS.indexOf(b.group) ||
    a.repo.localeCompare(b.repo) || a.pr.number - b.pr.number);
}
