/**
 * Values both the server and the frontend need at runtime, with no imports.
 *
 * This module exists to keep `@get-bb/plugin-sdk` and zod out of the frontend
 * bundle's dependency graph. `contract.ts` imports `defineRpcContract` from the
 * SDK root, which the app build cannot resolve: the SDK is a devDependency, so
 * a production install prunes it, and only `@get-bb/plugin-sdk/app` is shimmed
 * for the frontend. Any runtime value `app.tsx` needs therefore lives here
 * rather than beside the schemas, so the app's imports from `contract.ts` stay
 * type-only and erase completely.
 */

/** Where the thread is in its arc, in display order. */
export const BRIEF_STAGES = [
  "discovery",
  "planning",
  "implementation",
  "review",
] as const;

export type BriefStage = (typeof BRIEF_STAGES)[number];

/**
 * The statuses a *stored* brief can resolve to, in sidebar-section order.
 *
 * `working` is absent because it is live thread state that never reaches a
 * stored row — which is also why these, and not the full status list, are what
 * a manual override may pick: pinning a thread to "working" would be pinning it
 * to a fact about right now.
 */
export const STORED_BRIEF_STATUSES = [
  "waiting-on-me",
  "waiting-on-other",
  "done",
] as const;

export type StoredBriefStatus = (typeof STORED_BRIEF_STATUSES)[number];

/** Realtime channel the server pokes when any brief changes. */
export const BRIEFS_CHANGED_CHANNEL = "briefs-changed";

/**
 * The bb thread statuses that mean the agent is running or queued, and so that
 * the thread is `working` whatever its stored brief says.
 *
 * Plain strings rather than the SDK's `ThreadStatus`, because this module is
 * imported by both the server and the frontend bundle and deliberately has no
 * imports. bb's own list treats an unknown status as idle; so does this.
 */
export const LIVE_WORKING_STATUSES = ["active", "starting", "pending"] as const;

/** Whether a live bb thread status means the agent is running or queued. */
export function isLiveWorking(threadStatus: string): boolean {
  return (LIVE_WORKING_STATUSES as readonly string[]).includes(threadStatus);
}
