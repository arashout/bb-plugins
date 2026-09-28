/**
 * Which sidebar section a thread belongs in, and the moves needed to get there.
 *
 * Pure: every `bb.*` call lives in `server.ts`. The grouping is driven entirely
 * by stored briefs, so this module needs no live thread state beyond each
 * thread's current section.
 */
import { effectiveStatus } from "./brief.js";
import type { BriefStatus, StoredBrief, StoredBriefStatus } from "./contract.js";

/**
 * The status sections, top to bottom.
 *
 * There is no `working` section. `working` is live thread state and never
 * reaches a stored brief (see {@link effectiveStatus}), so a section keyed on it
 * could not have members: a running thread sits in the section its last brief
 * implies and keeps bb's own running indicator. Grouping running threads
 * separately would mean reacting to live state, which is what keeps the server
 * out of per-thread lookups.
 */
export const STATUS_SECTIONS = [
  { status: "waiting-on-me", name: "Waiting on you" },
  { status: "waiting-on-other", name: "Blocked" },
  { status: "done", name: "Done" },
  // Typed against the stored statuses rather than all of them, so a section
  // cannot be keyed on `working` — which could never have members.
] as const satisfies readonly { status: StoredBriefStatus; name: string }[];

/** The section names this plugin owns, top to bottom. */
export const SECTION_NAMES: readonly string[] = STATUS_SECTIONS.map(
  (entry) => entry.name,
);

/**
 * The status a stored brief resolves to, with no live input folded in.
 *
 * Deliberately the *effective* status, so a thread pinned by hand is filed
 * where the pin says. A grouping that ignored the override would put the thread
 * straight back into the section you moved it out of — which is the only way to
 * move a thread in this sidebar, since a section assignment never feeds back
 * into a brief.
 */
export function storedStatus(stored: StoredBrief): BriefStatus {
  return effectiveStatus(stored);
}

/** The section for a stored status, or null when no section covers it. */
export function sectionNameForStatus(status: BriefStatus): string | null {
  return STATUS_SECTIONS.find((entry) => entry.status === status)?.name ?? null;
}

/**
 * `thread-list`'s top-to-bottom order: pinned first, our sections in
 * {@link STATUS_SECTIONS} order, then bb's built-in Threads group.
 *
 * Threads last is deliberate. A thread with no brief is left unassigned rather
 * than filed anywhere, so that group *is* the "no brief yet" bucket — including
 * for a thread created since the last sync, which is why it must never be
 * hidden.
 */
export function manualSectionOrder(sectionIds: readonly string[]): string[] {
  return ["pinned", ...sectionIds.map((id) => `section:${id}`), "threads"];
}

export interface SectionedThread {
  id: string;
  sectionId: string | null;
}

export interface AssignmentMove {
  threadId: string;
  /** null clears the assignment, dropping the thread into bb's Threads group. */
  sectionId: string | null;
}

export interface PlanAssignmentsArgs {
  /** The threads eligible for grouping: visible, not archived, not deleted. */
  threads: readonly SectionedThread[];
  /**
   * Target section per thread that has a brief with a section-backed status.
   * A thread absent from this map is treated as briefless.
   */
  sectionIdByThreadId: ReadonlyMap<string, string>;
  /** Every section id this plugin owns, so a stale assignment can be cleared. */
  ownedSectionIds: ReadonlySet<string>;
}

/**
 * The moves needed and nothing more.
 *
 * Idempotent by construction: a thread already in the right section produces no
 * move, so re-planning the result of a plan is empty. That is what makes the
 * sync safe to run on every brief write and on startup.
 *
 * A briefless thread is cleared only when it currently sits in a section this
 * plugin owns — a stale assignment from a brief since deleted. A thread the user
 * filed in their own section keeps it: a catch-all is not worth overwriting a
 * deliberate placement.
 */
export function planAssignments(args: PlanAssignmentsArgs): AssignmentMove[] {
  const moves: AssignmentMove[] = [];
  for (const thread of args.threads) {
    const target = args.sectionIdByThreadId.get(thread.id);
    if (target === undefined) {
      if (
        thread.sectionId !== null &&
        args.ownedSectionIds.has(thread.sectionId)
      ) {
        moves.push({ threadId: thread.id, sectionId: null });
      }
      continue;
    }
    if (thread.sectionId !== target) {
      moves.push({ threadId: thread.id, sectionId: target });
    }
  }
  return moves;
}
