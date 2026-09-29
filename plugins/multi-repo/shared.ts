/**
 * Runtime values the frontend bundle may import.
 *
 * `contract.ts` reaches `@get-bb/plugin-sdk` root for `defineRpcContract`,
 * which the app build does not resolve, so `app.tsx` imports types from there
 * and every runtime constant from here.
 */

/** Realtime channel: the workspace manifest or repo set for a project changed. */
export const REPOS_CHANGED_CHANNEL = "multi-repo.changed";

/** The nav panel's route segment and id. */
export const REPOS_PANEL_ID = "repos";
export const REPOS_PANEL_PATH = "repos";

/** The thread panel action that owns diff and PR. */
export const CHANGES_ACTION_ID = "changes";
export const CHANGES_TAB_TITLE = "Changes";

export const ENVIRONMENT_PROVIDER_ID = "multi-repo-workspace";

/**
 * Caps, not budgets.
 *
 * bb's own diff surface tiers, paginates, virtualizes and counts bytes. None
 * of that is built here — the panel caps the file count and the per-file patch
 * size instead and says so in the UI. A workspace whose diff exceeds these is
 * rare enough that "open it in the repo" is a fair answer, and building the
 * hardening before anyone hits the cap would be the expensive half of a diff
 * viewer for no one.
 */
export const MAX_DIFF_FILES = 400;
export const MAX_PATCH_BYTES = 512 * 1024;

/** How long a cached PR read stays fresh before the panel refetches it. */
export const PR_CACHE_TTL_MS = 60_000;

/** How long a cache entry may go unfetched before `create()` refreshes it. */
export const CACHE_FRESH_MS = 10 * 60 * 1000;

/** The background sweep's target freshness, which is looser than a cold start's. */
export const CACHE_BACKGROUND_MS = 60 * 60 * 1000;

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export function changeStatusLabel(status: ChangeStatus): string {
  switch (status) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
  }
}

/** Tailwind text colors matching bb's own diff gutters, one per status. */
export function changeStatusTone(status: ChangeStatus): string {
  switch (status) {
    case "added":
    case "untracked":
      return "text-green-600 dark:text-green-500";
    case "deleted":
      return "text-red-600 dark:text-red-500";
    case "renamed":
      return "text-blue-600 dark:text-blue-500";
    case "modified":
      return "text-amber-600 dark:text-amber-500";
  }
}
