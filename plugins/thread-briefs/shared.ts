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

/**
 * The hues a project's ring can take, in OKLCH, evenly spaced around the wheel.
 *
 * This plugin's own grouping is what makes the colour affordable. `status`
 * grouping replaces the sidebar's project grouping with the status sections, so
 * nothing on the row says which project a thread belongs to any more — and at
 * the same time the section header takes over the one thing the ring's colour
 * used to carry, `done`. The stage stays on the ring's shape, the status stays
 * in the heading, and the colour is left free for the project. Every ring takes
 * one, so the channel means exactly one thing on every row.
 *
 * Hues rather than finished colours because the ring has to read on both the
 * light and the dark sidebar and no single lightness does: one that clears 3:1
 * against white is muddy against the dark surface, and one that glows on dark
 * disappears on white. Each hue is rendered at two lightnesses through
 * `light-dark()` instead — bb sets `color-scheme` on both its themes, so the
 * browser picks the right one and a theme switch needs no re-render.
 *
 * Eight is where two projects colliding on one hue stops being likely and
 * telling two hues apart at 16px starts to get hard.
 */
export const PROJECT_RING_HUES = [20, 65, 110, 155, 200, 245, 290, 335] as const;

/** The `stroke`/`fill` value for a project's ring, light theme and dark. */
export function projectRingColor(colorIndex: number): string {
  const hue = PROJECT_RING_HUES[colorIndex % PROJECT_RING_HUES.length];
  return `light-dark(oklch(0.55 0.15 ${hue}), oklch(0.76 0.13 ${hue}))`;
}

/**
 * The grey a done thread's ring takes once it has gone cold.
 *
 * Chroma exactly zero, so it cannot be mistaken for one of
 * {@link PROJECT_RING_HUES} that happens to render dull — the whole reading is
 * "this ring has no project colour", and a nearly-grey blue would make that a
 * judgement call at 16px. Two lightnesses through `light-dark()` for the same
 * reason the hues have two: one grey that reads against the light sidebar is
 * muddy on the dark one.
 */
export const STALE_DONE_RING_COLOR =
  "light-dark(oklch(0.62 0 0), oklch(0.58 0 0))";

/** Default hours of no activity before a done thread's ring goes grey. */
export const DEFAULT_DONE_STALE_HOURS = 24;

/**
 * Default hours of no activity before a done thread is archived.
 *
 * Twice the stale threshold, so the grey ring is a full day's warning rather
 * than a state the thread passes through on its way out.
 */
export const DEFAULT_DONE_ARCHIVE_HOURS = 48;

/** Hours from a setting as milliseconds; 0 or nonsense means "off". */
export function hoursToMs(hours: unknown): number {
  return typeof hours === "number" && Number.isFinite(hours) && hours > 0
    ? hours * 3_600_000
    : 0;
}

/**
 * How long a thread has sat untouched, from bb's own attention cursor.
 *
 * `latestAttentionAt` rather than `updatedAt` for the same reason the refresher
 * uses it: this plugin writes a thread's title and its section, and both move
 * `updatedAt`. Filing a done thread into the ✅ Done section would otherwise
 * reset the very clock the threads in that section are being timed on, and
 * nothing would ever go stale. Not `lastSummarizedAt` either — the panel's
 * Re-summarize button moves that, so reading a finished thread would postpone
 * its archiving.
 *
 * Clamped at zero: a cursor in the future is clock skew between the server that
 * stamped it and whoever is reading it, and counting backwards from it would
 * make a fresh thread look ancient.
 */
export function idleMsSince(latestAttentionAt: number, now: number): number {
  return Math.max(0, now - latestAttentionAt);
}

/**
 * Whether a done thread has gone cold: the one rule behind both the grey ring
 * and the auto-archive, so the ring is always the warning for the archive that
 * follows rather than a second opinion about it.
 *
 * A threshold of 0 means off, matching the settings that feed it.
 */
export function isStaleDone(args: {
  status: string;
  latestAttentionAt: number;
  now: number;
  afterMs: number;
}): boolean {
  if (args.status !== "done") return false;
  if (args.afterMs <= 0) return false;
  return idleMsSince(args.latestAttentionAt, args.now) >= args.afterMs;
}

/**
 * The palette slot a project gets, from a hash of its id.
 *
 * Hashed rather than assigned, so the colour needs nothing stored and is the
 * same in every window, on every machine, across reloads. Hashing the id rather
 * than indexing a sorted list also means adding or removing a project leaves
 * every other project's colour alone — a list index would reshuffle them.
 *
 * FNV-1a, via `Math.imul` so the multiply stays 32-bit.
 */
export function projectColorIndex(projectId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < projectId.length; index += 1) {
    hash ^= projectId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % PROJECT_RING_HUES.length;
}
