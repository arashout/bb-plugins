import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { BRIEF_STAGES, type BriefStage } from "./shared.js";

/**
 * Where the thread is in its arc. A semantic judgement the summarizer makes
 * from the transcript, which the user can override by hand. Built from the
 * plain list in `shared.ts` so the stages have one definition.
 */
export const briefStageSchema = z.enum(BRIEF_STAGES);
export type { BriefStage };

/**
 * Who the thread is waiting on. Derived mechanically rather than asked of the
 * model, so it stays correct between summaries.
 *
 * Three of the four come from the stored brief; `working` is live thread state
 * and is only ever applied on the client, so it never appears in a stored row
 * or in a row signal off the wire.
 */
export const briefStatusSchema = z.enum([
  "working",
  "waiting-on-me",
  "waiting-on-other",
  "done",
]);
export type BriefStatus = z.infer<typeof briefStatusSchema>;

export { BRIEF_STAGES };

/**
 * Who has to take `nextStep`. The one part of the status the model has to judge
 * rather than the code: "test it and tell me" and "keep going" are both concrete
 * next actions, and nothing in the prose distinguishes them.
 */
export const NEXT_STEP_ACTORS = ["me", "agent", "other"] as const;
export const nextStepActorSchema = z.enum(NEXT_STEP_ACTORS);
export type NextStepActor = z.infer<typeof nextStepActorSchema>;

/**
 * A thread title the summarizer proposed, after normalization.
 *
 * Short enough to survive a sidebar row: bb clamps its own generated titles to
 * 48 display columns, and a name that only reads in the popover is no use to
 * the surface this exists for.
 */
export const MAX_TITLE_LENGTH = 48;

/**
 * The fields the summarizer is asked to return, exactly as it returns them.
 *
 * The five prose fields are strings, where an empty string means "nothing to
 * say" — meaningful for `nextStep` (the work is done) and `blockedOn` (nothing
 * is blocking). The display skips empty fields.
 *
 * `nextStepActor` and `title` are the odd ones out: not prose, and optional.
 * Optional is load-bearing — see {@link storedBriefSchema}.
 */
export const briefFieldsSchema = z
  .object({
    goal: z.string(),
    currentState: z.string(),
    nextStep: z.string(),
    /**
     * A four-to-six-word name for the thread, when the model gave one we could
     * use. Absent means unknown, which is both a brief written before this
     * field existed and one the model answered with nothing usable; either way
     * the thread keeps whatever title it already has.
     */
    title: z.string().max(MAX_TITLE_LENGTH).optional(),
    /**
     * Who has to take `nextStep`, when the model offered a value we recognise.
     * Absent means unknown, which is both a brief written before this field
     * existed and one whose `nextStep` is empty; either way the status falls
     * back to the actor-free derivation.
     */
    nextStepActor: nextStepActorSchema.optional(),
    blockedOn: z.string(),
    constraints: z.string(),
  })
  .strict();
export type BriefFields = z.infer<typeof briefFieldsSchema>;

/** What the summarizer returns: the five fields plus its stage judgement. */
export const summaryResultSchema = briefFieldsSchema
  .extend({ stage: briefStageSchema })
  .strict();
export type SummaryResult = z.infer<typeof summaryResultSchema>;

/**
 * The persisted row, one per thread, under kv key `brief:<threadId>`.
 *
 * `stage` and `status` are deliberately absent: `stage` is
 * `stageOverride ?? modelStage` and `status` is derived from `nextStep`,
 * `blockedOn` and `nextStepActor`, all resolved on read so none goes stale
 * between summaries. The live `working` override is applied later still, per row
 * on the client.
 *
 * New fields must be optional and `version` must stay at 1. `readBrief` deletes
 * any row that fails this parse, and briefs are never backfilled, so a required
 * field would silently drop every brief written before it and leave dormant
 * threads with no glyph and nothing to regenerate from.
 */
export const storedBriefSchema = z
  .object({
    version: z.literal(1),
    threadId: z.string(),
    fields: briefFieldsSchema,
    /** The stage the summarizer judged from the transcript. */
    modelStage: briefStageSchema,
    /** A manual stage that wins over `modelStage` until real new activity. */
    stageOverride: briefStageSchema.nullable(),
    /**
     * The thread's activity cursor when the override was set. The override is
     * dropped once the thread's cursor moves past it, so "sticks until real
     * thread activity" needs no timer.
     */
    stageOverrideSeq: z.number().nullable(),
    /**
     * Whether the thread's last assistant turn read as a question.
     *
     * No longer an input to `status`: an idle thread that is neither done nor
     * blocked is waiting on us whether or not it ended by asking something.
     * Kept because it is cheap to write and the obvious raw material for a
     * future "the agent asked *this*" line in the popover; nothing reads it
     * today.
     */
    endedWithQuestion: z.boolean(),
    /**
     * The thread title this plugin last wrote, or null if it has never written
     * one.
     *
     * The whole of the "do not clobber a name you chose" rule. bb records no
     * provenance for a title — there is no column saying whether it came from
     * bb's opening-prompt guess, from a rename, or from us — so remembering
     * what we wrote is the only way to tell our own title apart from yours.
     * Finding something else in `thread.title` means someone renamed the
     * thread, and renaming stops there: we leave this field alone, so the
     * mismatch persists and every later summary skips the rename too.
     */
    appliedTitle: z.string().nullable().optional(),
    lastSummarizedAt: z.number(),
    /** The thread's `conversationOutline().maxSeq` at summarize time. */
    lastActivitySeen: z.number(),
  })
  .strict();
export type StoredBrief = z.infer<typeof storedBriefSchema>;

/** A brief resolved for display: stored prose plus the derived facts. */
export const resolvedBriefSchema = briefFieldsSchema
  .extend({
    threadId: z.string(),
    stage: briefStageSchema,
    status: briefStatusSchema,
    stageOverride: briefStageSchema.nullable(),
    lastSummarizedAt: z.number(),
  })
  .strict();
export type ResolvedBrief = z.infer<typeof resolvedBriefSchema>;

/**
 * What the frontend sees for one thread.
 *
 * `summarizing` means work is genuinely pending — debounced, queued, or in
 * flight. `absent` means there is no brief and none is coming, which is the
 * normal state for a thread that was already dormant when the plugin arrived:
 * briefs are not backfilled, so the UI offers to make one on demand rather
 * than claiming a summary is on its way.
 */
export const briefStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), brief: resolvedBriefSchema }).strict(),
  z.object({ state: z.literal("summarizing") }).strict(),
  z.object({ state: z.literal("absent") }).strict(),
  z.object({ state: z.literal("unconfigured"), message: z.string() }).strict(),
  z.object({ state: z.literal("error"), message: z.string() }).strict(),
]);
export type BriefState = z.infer<typeof briefStateSchema>;

/** The per-row signal the sidebar draws: one glyph, no prose. */
export const rowSignalSchema = z
  .object({
    threadId: z.string(),
    status: briefStatusSchema,
    stage: briefStageSchema,
    /**
     * Short accessible label for the glyph, e.g. "Review — Waiting on you".
     * Stage first, because the glyph draws the stage and the label is the only
     * thing that names it.
     */
    label: z.string(),
  })
  .strict();
export type RowSignal = z.infer<typeof rowSignalSchema>;

export { BRIEFS_CHANGED_CHANNEL } from "./shared.js";

export const rpcContract = defineRpcContract({
  /** The brief for one thread, for the thread-header popover. */
  getBrief: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: briefStateSchema,
  },
  /**
   * One signal per stored brief. The client decides which ones actually draw a
   * glyph, because the last input to that decision — whether the thread has a
   * pending interaction — is data the sidebar already holds.
   */
  listRowSignals: {
    input: z.null(),
    output: z.object({ signals: z.array(rowSignalSchema) }).strict(),
  },
  /** Set or clear the manual stage. Clearing returns to the model's judgement. */
  setStageOverride: {
    input: z
      .object({
        threadId: z.string().min(1),
        stage: briefStageSchema.nullable(),
      })
      .strict(),
    output: briefStateSchema,
  },
  /** Queue an immediate re-summary, bypassing the quiet-period debounce. */
  refresh: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ queued: z.boolean() }).strict(),
  },
});
