// The effort deck's shared keys and its one "Needs you" rule (plan amendment
// A15). This module imports nothing, so the browser bundle can use it without
// reaching a server module (A12.1): the deck read model, batch actions, the
// deck, and the All PRs table all count with it.

/** Realtime: the server publishes it after each inventory read or action, pile move, and thread change. */
export const DECK_CHANGED = "deck-changed";

/**
 * A row's section: the move it needs, in the order a card lists them. Each of the first six is yours; in-flight rows need nothing from
 * anyone yet, and blocked rows wait on someone or something else.
 */
export const DECK_SECTIONS = ["merge", "confirm", "nudge", "request", "ready", "work", "flight", "blocked"] as const;
export type DeckSection = (typeof DECK_SECTIONS)[number];
const YOURS = new Set<DeckSection>(["merge", "confirm", "nudge", "request", "ready", "work"]);

/** The pile a row's card is on; Unclassified rows are "to sort". */
export type DeckPile = "active" | "held" | "done" | "unclassified";
/** What you last did to a row: a write waiting out its Undo window or running, sent, refused, or cut off by a restart mid-send. */
export type RowActed = { kind: string; state: "queued" | "sending" | "sent" | "refused" | "unknown"; at: number };
/** How long a write you made marks its row. An older one is history, so the row counts again whether or not you marked it seen. */
export const ACTED_MS = 86_400_000;

/**
 * A row you acted on dims and stops counting while its write waits or runs, and after it lands until you mark it seen at or after that
 * time: `seenAt`, which the view keeps. A refusal, or a send a restart cut off, leaves the move yours.
 */
export function counted(row: { acted: RowActed | null }, seenAt = Number.NEGATIVE_INFINITY): boolean {
  const { acted } = row;
  if (!acted || acted.state === "refused" || acted.state === "unknown") return true;
  return acted.state === "sent" && acted.at <= seenAt;
}

/** Needs you: an open PR in an active effort or One-offs whose next move is yours. Held and done efforts pause, and Unclassified PRs are to sort. */
export function needsYou(row: { section: DeckSection; acted: RowActed | null }, pile: DeckPile, seenAt?: number): boolean {
  return pile === "active" && YOURS.has(row.section) && counted(row, seenAt);
}
