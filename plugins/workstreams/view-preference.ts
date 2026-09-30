export type ViewId = "deck" | "inventory" | "map" | "pipeline" | "work" | "efforts" | "board" | "roster";

/**
 * Renamed when the effort deck became the front door (plan amendment A15), as it was when the PR inventory did (A13), so a view
 * remembered before then opens the deck once; after that, the panel reopens the last view you chose.
 */
export const VIEW_STORAGE_KEY = "bb-workstreams:last-view-since-deck";

export function viewFromSubPath(subPath: string): ViewId | null {
  const head = subPath.split("/").find(Boolean);
  return head === "board-v2" ? "board" : head === "deck" || head === "inventory" || head === "map" || head === "pipeline" || head === "work" || head === "efforts" || head === "board"
    || head === "roster" ? head : null;
}

/** `roster` (the effort picker), `roster/<effortId>`, or `roster/<effortId>/<n>` (focus row n); null for any other view. */
export function rosterRoute(subPath: string): { effortId: string | null; n: number | null } | null {
  const [head, effortId, n] = subPath.split("/").filter(Boolean);
  if (head !== "roster") return null;
  const decoded = (() => { try { return effortId === undefined ? null : decodeURIComponent(effortId); } catch { return effortId!; } })();
  return { effortId: decoded, n: n !== undefined && /^\d+$/u.test(n) ? Number(n) : null };
}

/** `deck/<card>`: the card to open, such as a thread's effort chip links to (an effort's id, or "unc"); null for any other path. */
export function deckRoute(subPath: string): string | null {
  const [head, card] = subPath.split("/").filter(Boolean);
  if (head !== "deck" || card === undefined) return null;
  try { return decodeURIComponent(card); } catch { return card; }
}

/**
 * What a `deck/<card>` link does with a deck read: open its card on the active ring, open the On hold pile for a held effort, or, when
 * the deck lacks it, read again if no read has landed since the link (a cached deck can predate a card just made), else let it go.
 */
export function deckLinkStep(card: string, deck: { ring: readonly string[]; held: readonly string[] }, readSinceLink: boolean): "open" | "hold" | "read" | "drop" {
  if (deck.ring.includes(card)) return "open";
  if (deck.held.includes(card)) return "hold";
  return readSinceLink ? "drop" : "read";
}

/** The view the panel root opens: the last one chosen, else the effort deck. */
export function readLastView(): ViewId {
  try {
    const saved = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return saved === "board" || saved === "board-v2" ? "board"
      : saved === "inventory" || saved === "map" || saved === "pipeline" || saved === "work" || saved === "efforts" ? saved : "deck";
  } catch {
    return "deck";
  }
}

/** A roster is one effort's page, never the view the panel root reopens. */
export function storeLastView(view: ViewId): void {
  if (view === "roster") return;
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // The view remains usable when storage is disabled.
  }
}
