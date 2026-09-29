// The one key registry the effort deck and All PRs share (plan amendment
// A15): every action with its key, which the key handler, the hint bar, the
// ? sheet, and the ⌘K palette all read, so a key means the same thing
// everywhere. This module imports nothing, so the browser bundle can use it
// without reaching a server module (A12.1).
//
// Safety lives in each action's effect. Only "confirm" and "preview" actions
// can lead to a GitHub write, and neither writes on its key: a confirm opens
// the listing of every PR it would touch, which then waits out its Undo
// window, and a preview opens the fresh merge preview, where only a click or
// ⌘↵ merges. Enter and Space are never bound to either.

export const KEY_GROUPS = ["Deck", "Card", "Act", "Rows", "Unclassified", "Anywhere"] as const;
export type KeyGroup = (typeof KEY_GROUPS)[number];
/**
 * What pressing the key does: move around, change only what the view shows, open a dialog, open a listing confirm for a batch write, or
 * open the fresh merge preview.
 */
export type KeyEffect = "nav" | "local" | "dialog" | "confirm" | "preview";
export type DeckActionId = "next" | "prev" | "jump" | "unclassified" | "view" | "seen" | "hold-pile" | "done-pile" | "advance" | "hold" | "complete"
  | "tiles" | "merge" | "confirm" | "nudge" | "request" | "ready" | "move" | "undo" | "hold-pr" | "refresh" | "row-next" | "row-prev" | "select"
  | "select-section" | "expand" | "clear" | "open-thread" | "open-pr" | "accept" | "one-off" | "new-effort" | "rule" | "seed" | "palette" | "help";
/** Keys as they read on a kbd: "]" and "→" are the same key, "1–9" names nine. */
export type DeckAction = { id: DeckActionId; group: KeyGroup; title: string; keys: readonly string[]; effect: KeyEffect };

export const DECK_ACTIONS: readonly DeckAction[] = [
  { id: "next", group: "Deck", title: "Next effort", keys: ["]", "→"], effect: "nav" },
  { id: "prev", group: "Deck", title: "Previous effort", keys: ["[", "←"], effect: "nav" },
  { id: "jump", group: "Deck", title: "Go to effort by number", keys: ["1–9"], effect: "nav" },
  { id: "unclassified", group: "Deck", title: "Unclassified", keys: ["u"], effect: "nav" },
  { id: "view", group: "Deck", title: "Switch Efforts and All PRs", keys: ["v"], effect: "nav" },
  { id: "seen", group: "Deck", title: "Mark seen here", keys: ["s"], effect: "local" },
  { id: "hold-pile", group: "Deck", title: "Show the On hold pile", keys: [], effect: "dialog" },
  { id: "done-pile", group: "Deck", title: "Show the Done pile", keys: [], effect: "dialog" },
  { id: "advance", group: "Card", title: "Advance this effort…", keys: ["a"], effect: "confirm" },
  { id: "hold", group: "Card", title: "Hold the effort…", keys: ["h"], effect: "dialog" },
  { id: "complete", group: "Card", title: "Complete the effort…", keys: [], effect: "dialog" },
  { id: "tiles", group: "Card", title: "Show or hide every tile's details", keys: ["i"], effect: "local" },
  { id: "merge", group: "Act", title: "Preview merge…", keys: ["m"], effect: "preview" },
  { id: "confirm", group: "Act", title: "Confirm review notes…", keys: ["c"], effect: "confirm" },
  { id: "nudge", group: "Act", title: "Nudge reviewers…", keys: ["n"], effect: "confirm" },
  { id: "request", group: "Act", title: "Request a reviewer…", keys: ["r"], effect: "confirm" },
  { id: "ready", group: "Act", title: "Mark ready…", keys: ["y"], effect: "confirm" },
  { id: "undo", group: "Act", title: "Undo the last action", keys: ["z"], effect: "local" },
  { id: "hold-pr", group: "Act", title: "Hold or release the PR…", keys: [], effect: "dialog" },
  { id: "refresh", group: "Act", title: "Refresh the PR from GitHub", keys: [], effect: "local" },
  { id: "row-next", group: "Rows", title: "Next row", keys: ["j", "↓"], effect: "nav" },
  { id: "row-prev", group: "Rows", title: "Previous row", keys: ["k", "↑"], effect: "nav" },
  { id: "select", group: "Rows", title: "Select or unselect the row", keys: ["x"], effect: "local" },
  { id: "select-section", group: "Rows", title: "Select what needs you in the section", keys: ["⇧X"], effect: "local" },
  { id: "expand", group: "Rows", title: "Show the row's details", keys: ["↵"], effect: "local" },
  { id: "clear", group: "Rows", title: "Clear the selection", keys: ["esc"], effect: "local" },
  { id: "open-thread", group: "Rows", title: "Open the row's thread", keys: ["o"], effect: "nav" },
  { id: "open-pr", group: "Rows", title: "Open the PR on GitHub", keys: [], effect: "nav" },
  { id: "accept", group: "Unclassified", title: "Accept the suggestion", keys: ["p"], effect: "local" },
  { id: "move", group: "Unclassified", title: "Move to an effort…", keys: ["e"], effect: "dialog" },
  { id: "one-off", group: "Unclassified", title: "Mark as one-offs", keys: [], effect: "local" },
  { id: "new-effort", group: "Unclassified", title: "New effort from the selection…", keys: [], effect: "dialog" },
  { id: "rule", group: "Unclassified", title: "Add a standing rule…", keys: [], effect: "dialog" },
  { id: "seed", group: "Unclassified", title: "Seed efforts from Linear…", keys: [], effect: "dialog" },
  { id: "palette", group: "Anywhere", title: "All actions", keys: ["⌘K"], effect: "dialog" },
  { id: "help", group: "Anywhere", title: "Keys and colors", keys: ["?"], effect: "dialog" },
];
export const ACTION: Readonly<Record<DeckActionId, DeckAction>> = Object.fromEntries(DECK_ACTIONS.map((action) => [action.id, action])) as never;

/** What a key event's key reads as on a kbd. */
const TOKEN: Record<string, string> = { ArrowRight: "→", ArrowLeft: "←", ArrowDown: "↓", ArrowUp: "↑", Enter: "↵", Escape: "esc" };
/** Only row movement repeats while the key is held; every other key fires once per press. */
const REPEATS = new Set(["row-next", "row-prev"]);

/**
 * The action a plain key press runs, and the effort number for 1–9. A key with ⌘, Ctrl, or Alt is never an action here except ⌘K, and
 * a held key repeats row movement only.
 */
export function actionForKey(event: { key: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; repeat?: boolean }):
  { id: DeckActionId; n?: number } | null {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") return { id: "palette" };
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (/^[1-9]$/u.test(event.key)) return event.repeat ? null : { id: "jump", n: Number(event.key) };
  const token = event.key === "X" && event.shiftKey ? "⇧X" : TOKEN[event.key] ?? event.key;
  const action = DECK_ACTIONS.find((candidate) => candidate.keys.includes(token));
  return action && (!event.repeat || REPEATS.has(action.id)) ? { id: action.id } : null;
}

/** Typing in a field is never an action, except Escape, which leaves it, and ⌘K. */
export function typingTarget(target: unknown): boolean {
  const element = target as { isContentEditable?: boolean; closest?: (selector: string) => unknown } | null;
  return !!element && (element.isContentEditable === true || !!element.closest?.("input, textarea, select, [contenteditable]"));
}
