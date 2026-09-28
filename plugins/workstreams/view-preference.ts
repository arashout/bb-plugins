export type ViewId = "map" | "pipeline" | "work" | "efforts" | "board";

export const VIEW_STORAGE_KEY = "bb-workstreams:last-view";

export function viewFromSubPath(subPath: string): ViewId | null {
  const head = subPath.split("/").find(Boolean);
  return head === "board-v2" ? "board" : head === "map" || head === "pipeline" || head === "work" || head === "efforts" || head === "board" ? head : null;
}

export function readLastView(): ViewId {
  try {
    const saved = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return saved === "board" || saved === "board-v2" ? "board" : saved === "pipeline" ? "pipeline" : saved === "work" ? "work" : saved === "efforts" ? "efforts" : "map";
  } catch {
    return "map";
  }
}

export function storeLastView(view: ViewId): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // The view remains usable when storage is disabled.
  }
}
