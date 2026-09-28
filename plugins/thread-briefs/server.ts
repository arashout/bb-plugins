import type { BbPluginApi, JsonValue } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  BRIEFS_CHANGED_CHANNEL,
  rpcContract,
  storedBriefSchema,
  type BriefStage,
  type BriefState,
  type RowSignal,
  type StoredBrief,
} from "./contract.js";
import {
  briefKey,
  deriveStatus,
  overrideHolds,
  planRename,
  resolveBrief,
  rowSignalFor,
  threadIdFromKey,
} from "./brief.js";
import {
  buildUserPrompt,
  parseSummary,
  requestSummary,
  type CompletionConfig,
} from "./summarize.js";
import { endsWithQuestion, renderTranscript, type OutlineItem } from "./transcript.js";
import {
  manualSectionOrder,
  planAssignments,
  sectionNameForStatus,
  storedStatus,
  SECTION_NAMES,
  type SectionedThread,
} from "./sections.js";

/** Cap on one summarizer call, so a hung endpoint cannot stall the queue. */
const REQUEST_TIMEOUT_MS = 60_000;
/**
 * Delay before a thread's **first** brief, in place of `quietSeconds`.
 *
 * The quiet period exists to stop a thread in active back-and-forth being
 * re-summarized every turn. On the first brief there is nothing to protect —
 * and that is when the absence shows most: no row glyph, no sidebar section, an
 * empty Brief panel, and bb's opening-prompt title still on the thread. It is
 * also the cheapest summary that thread will ever cost, because the transcript
 * is at its shortest.
 *
 * Long enough to coalesce a thread that goes idle and straight back to work,
 * short enough that the panel's "Summarizing…" arrives while you are looking.
 */
const FIRST_BRIEF_DELAY_MS = 5_000;

/**
 * The first-brief delay, never longer than the quiet period it stands in for —
 * a `quietSeconds` tuned below it is asking for briefs sooner, not later.
 */
const firstBriefDelayMs = (quietMs: number) =>
  Math.min(FIRST_BRIEF_DELAY_MS, quietMs);
/** Backstop sweep: catches activity whose `thread.idle` we never saw. */
const SWEEP_CRON = "*/10 * * * *";
/** Threads considered per sweep, newest first. */
const SWEEP_LIMIT = 200;
/** The plugin that owns the sidebar list, and so its layout preferences. */
const THREAD_LIST_PLUGIN_ID = "thread-list";
/** Where the grouping records what it changed, so `off` can put it back. */
const SIDEBAR_STATE_KEY = "sidebar-grouping-state";
/** One page of the thread list while reconciling sections. */
const SECTION_PAGE_SIZE = 200;
/**
 * Cap on a reconcile, so a very long thread list cannot turn one brief write
 * into an unbounded walk.
 */
const SECTION_THREAD_LIMIT = 2_000;
/**
 * Quiet period before a reconcile. Brief writes arrive one per summarized
 * thread; this coalesces a burst of them into a single pass.
 */
const SECTION_SYNC_DEBOUNCE_MS = 2_000;

/** The `thread-list` preferences the grouping takes over, and their targets. */
const GROUPED_PREFS = {
  organizationMode: "chronological",
  chronologicalSort: "updated",
} as const;

/** What the grouping changed, recorded before the first write. */
interface SidebarGroupingState {
  applied: boolean;
  /** Prior preference values, or null for one bb had never been given. */
  previous: Record<string, unknown> | null;
}

export { rpcContract };

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    baseUrl: {
      type: "string",
      label: "API base URL (root or full /chat/completions endpoint)",
      default: "https://api.openai.com/v1",
    },
    apiKey: { type: "string", label: "API key", secret: true },
    model: { type: "string", label: "Model", default: "gpt-4o-mini" },
    jsonMode: {
      type: "boolean",
      label: "Request JSON mode",
      default: true,
    },
    quietSeconds: {
      type: "number",
      label: "Quiet period before summarizing (seconds)",
      default: 120,
    },
    renameThreads: {
      type: "boolean",
      label: "Rename threads to the brief's title",
      description:
        "Replaces bb's opening-prompt title with the short name the summarizer chose, refreshed on every summary. Stops renaming a thread for good once you rename it yourself. bb's original title is not kept anywhere, so turning this off leaves the last name it wrote in place.",
      default: false,
    },
    sidebarGrouping: {
      type: "select",
      label: "Group sidebar threads by brief status",
      description:
        '"status" replaces the sidebar\'s project grouping with Waiting on you / Blocked / Done sections, newest first inside each. "off" puts the previous grouping back and removes the sections.',
      options: ["off", "status"],
      default: "off",
    },
  });

  const initial = await settings.get();
  if (
    typeof initial.apiKey !== "string" ||
    initial.apiKey.trim() === ""
  ) {
    bb.status.needsConfiguration(
      `Set an API key with \`bb plugin config ${bb.pluginId} set apiKey <key>\`, then reload.`,
    );
  }

  // ---------------------------------------------------------------- storage

  const readBrief = async (threadId: string): Promise<StoredBrief | null> => {
    const raw = await bb.storage.kv.get<unknown>(briefKey(threadId));
    if (raw === undefined) return null;
    const parsed = storedBriefSchema.safeParse(raw);
    if (!parsed.success) {
      // A row written by an older/newer shape is not worth crashing a read
      // over; drop it and let the next summary rewrite it.
      bb.log.warn(`discarding unreadable brief for ${threadId}`);
      await bb.storage.kv.delete(briefKey(threadId));
      return null;
    }
    return parsed.data;
  };

  const writeBrief = async (brief: StoredBrief) => {
    await bb.storage.kv.set(briefKey(brief.threadId), brief);
  };

  const deleteBrief = async (threadId: string) => {
    await bb.storage.kv.delete(briefKey(threadId));
  };

  const announce = () => {
    // A summary already in flight when the plugin is disposed still runs its
    // `finally`, and publishing on a torn-down handle throws. Nobody is
    // listening on a dead generation anyway.
    if (lifetime.signal.aborted) return;
    bb.realtime.publish(BRIEFS_CHANGED_CHANNEL, { at: Date.now() });
  };

  // ------------------------------------------------------------ queue/timers

  const lifetime = new AbortController();
  /**
   * When this plugin generation started. The cutoff for "has there been
   * activity?": threads that last moved before we were running are not
   * backfilled.
   */
  const loadedAt = Date.now();
  /** Per-thread debounce timers: the thread must stay quiet to be summarized. */
  const debounces = new Map<string, ReturnType<typeof setTimeout>>();
  /** Threads waiting for the single worker, in arrival order. */
  const queue: string[] = [];
  /** Threads to summarize even when the activity cursor has not moved. */
  const forced = new Set<string>();
  /**
   * Threads queued from `thread.active` — a first brief written from the opening
   * prompt, before the turn it describes has finished. Flagged because such a
   * brief must not name the thread: see {@link summarizeThread}.
   */
  const preTurn = new Set<string>();
  /** The thread the single worker is summarizing right now, if any. */
  let inFlight: string | null = null;
  let draining = false;

  /** Whether a summary for this thread is genuinely pending or running. */
  const isPending = (threadId: string) =>
    debounces.has(threadId) || queue.includes(threadId) || inFlight === threadId;

  const enqueue = (threadId: string) => {
    if (!queue.includes(threadId)) queue.push(threadId);
    void drain();
  };

  /**
   * Debounce a thread. `thread.idle` fires on every turn boundary, so a thread
   * in active back-and-forth would otherwise be re-summarized every turn; we
   * want the brief written once the burst has actually stopped.
   */
  const scheduleSummary = (threadId: string, delayMs: number) => {
    const existing = debounces.get(threadId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      debounces.delete(threadId);
      enqueue(threadId);
    }, delayMs);
    // Never hold the process open for a brief.
    timer.unref?.();
    debounces.set(threadId, timer);
  };

  const cancelSummary = (threadId: string) => {
    const existing = debounces.get(threadId);
    if (existing !== undefined) {
      clearTimeout(existing);
      debounces.delete(threadId);
    }
  };

  async function drain() {
    if (draining) return;
    draining = true;
    let wrote = false;
    try {
      while (queue.length > 0 && !lifetime.signal.aborted) {
        const threadId = queue.shift();
        if (threadId === undefined) break;
        const force = forced.delete(threadId);
        const beforeFirstTurn = preTurn.delete(threadId);
        inFlight = threadId;
        try {
          const changed = await summarizeThread(threadId, { force, beforeFirstTurn });
          if (changed) {
            wrote = true;
            announce();
          }
        } catch (error) {
          bb.log.warn(
            `brief for ${threadId} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } finally {
          inFlight = null;
          // The thread drops back to `absent` on failure, so the UI stops
          // saying "summarizing" and offers an explicit retry instead.
          announce();
        }
      }
    } finally {
      draining = false;
      // One reconcile for the whole batch, once the queue is empty.
      if (wrote) scheduleReconcile();
    }
  }

  // ------------------------------------------------------------- summarizing

  const completionConfig = async (): Promise<CompletionConfig> => {
    const values = await settings.get();
    const apiKey = typeof values.apiKey === "string" ? values.apiKey.trim() : "";
    if (apiKey === "") {
      throw Object.assign(new Error("no API key configured"), {
        name: "NeedsConfigurationError",
      });
    }
    return {
      baseUrl: values.baseUrl,
      apiKey,
      model: values.model,
      jsonMode: values.jsonMode,
    };
  };

  /**
   * Put the brief's title on the thread, and report the title we are now on
   * record as having written.
   *
   * Returns the previous `appliedTitle` unchanged whenever nothing was written
   * — including on failure — because that value is what makes a hand-rename
   * stick: see {@link planRename}.
   *
   * The thread is re-read first. `summarizeThread` fetched it before a
   * summarizer call that can take a minute, and a rename during that minute is
   * exactly the case this must not lose.
   */
  async function applyTitle(args: {
    threadId: string;
    title: string | undefined;
    applied: string | null;
    /** The title as of before the summarizer call. */
    staleCurrent: string | null;
  }): Promise<string | null> {
    if (!(await settings.get()).renameThreads) return args.applied;
    // Cheap pre-check on what we already hold, so a settled thread costs no
    // extra round trip; the authoritative check is below.
    if (
      planRename({
        current: args.staleCurrent,
        desired: args.title,
        applied: args.applied,
      }) === null
    ) {
      return args.applied;
    }

    const fresh = await bb.sdk.threads.get({ threadId: args.threadId }).catch(() => null);
    if (fresh === null) return args.applied;
    const title = planRename({
      current: fresh.title,
      observed: args.staleCurrent,
      desired: args.title,
      applied: args.applied,
    });
    if (title === null) return args.applied;

    try {
      await bb.sdk.threads.update({ threadId: args.threadId, title });
    } catch (error) {
      // A rename is not worth losing the brief over. Keeping the old
      // `appliedTitle` also keeps the thread eligible for a retry next time.
      bb.log.warn(
        `could not rename ${args.threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return args.applied;
    }
    return title;
  }

  /**
   * Carry a manual override through a summary, or drop it.
   *
   * An override is anchored to the cursor it was set at and survives only while
   * the thread has not moved past it: a forced re-summary of an unchanged thread
   * keeps the pin, and a summary that follows a real turn retires it. The
   * original anchor is kept rather than re-stamped to the new cursor — restamping
   * would make every override permanent, since the pin would advance in step with
   * the activity meant to expire it.
   */
  function carryOverride<T>(
    value: T | null | undefined,
    anchorSeq: number | null | undefined,
    cursor: number,
  ): { value: T | null; seq: number | null } {
    const kept = value ?? null;
    if (kept === null || !overrideHolds(anchorSeq, cursor)) {
      return { value: null, seq: null };
    }
    return { value: kept, seq: anchorSeq ?? cursor };
  }

  /**
   * Returns true when a brief was written (so callers know to announce).
   *
   * `beforeFirstTurn` marks a brief written from the opening prompt while the
   * first turn is still running. It is summarized like any other, but the thread
   * is **not** renamed: a title chosen from the opening prompt alone is only as
   * good as the one bb already guessed from it, and the summary that follows the
   * turn will choose a better one — so applying it here would rename the thread
   * twice within a minute, and each rename also dispatches a command into the
   * thread's environment.
   */
  async function summarizeThread(
    threadId: string,
    { force, beforeFirstTurn }: { force: boolean; beforeFirstTurn: boolean },
  ): Promise<boolean> {
    const thread = await bb.sdk.threads
      .get({ threadId })
      .catch(() => null);
    if (thread === null) {
      await deleteBrief(threadId);
      return true;
    }
    // Hidden threads are plugin workers, not work the user is tracking.
    if (thread.visibility === "hidden" || thread.deletedAt !== null) {
      await deleteBrief(threadId);
      return true;
    }

    const outline = await bb.sdk.threads.conversationOutline({ threadId });
    if (outline.items.length === 0) return false;

    const stored = await readBrief(threadId);
    if (
      !force &&
      stored !== null &&
      stored.lastActivitySeen >= outline.maxSeq
    ) {
      // Nothing new has happened since the last brief.
      return false;
    }

    const config = await completionConfig();
    const { output } = await bb.sdk.threads.output({ threadId });

    // A stage override in force is passed to the model as fixed; one the thread
    // has moved past is dropped here, which is what "sticks until real thread
    // activity" means. The status override needs no such handoff — the model is
    // never asked for a status — but expires on the same terms.
    const stagePin = carryOverride(
      stored?.stageOverride,
      stored?.stageOverrideSeq,
      outline.maxSeq,
    );
    const statusPin = carryOverride(
      stored?.statusOverride,
      stored?.statusOverrideSeq,
      outline.maxSeq,
    );

    const transcript = renderTranscript({
      title: thread.title ?? thread.titleFallback,
      outline: outline.items.map(
        (item): OutlineItem => ({ role: item.role, preview: item.preview }),
      ),
      lastAssistantText: output,
      previousBrief: stored?.fields ?? null,
    });

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = AbortSignal.any([timeout, lifetime.signal]);
    const reply = await requestSummary(
      config,
      buildUserPrompt({ transcript, fixedStage: stagePin.value }),
      signal,
    );
    const summary = parseSummary(reply, stagePin.value);

    const appliedTitle = beforeFirstTurn
      ? (stored?.appliedTitle ?? null)
      : await applyTitle({
          threadId,
          title: summary.title,
          applied: stored?.appliedTitle ?? null,
          staleCurrent: thread.title,
        });

    await writeBrief({
      version: 1,
      threadId,
      fields: {
        title: summary.title,
        goal: summary.goal,
        currentState: summary.currentState,
        nextStep: summary.nextStep,
        nextStepActor: summary.nextStepActor,
        blockedOn: summary.blockedOn,
        constraints: summary.constraints,
      },
      modelStage: summary.stage,
      stageOverride: stagePin.value,
      stageOverrideSeq: stagePin.seq,
      statusOverride: statusPin.value,
      statusOverrideSeq: statusPin.seq,
      endedWithQuestion: endsWithQuestion(output),
      appliedTitle,
      lastSummarizedAt: Date.now(),
      lastActivitySeen: outline.maxSeq,
    });
    return true;
  }

  // -------------------------------------------------------------- reading

  const briefState = async (threadId: string): Promise<BriefState> => {
    const stored = await readBrief(threadId);
    if (stored === null) {
      const values = await settings.get();
      if (typeof values.apiKey !== "string" || values.apiKey.trim() === "") {
        return {
          state: "unconfigured",
          message: "Add an API key in this plugin's settings to generate briefs.",
        };
      }
      // Only claim a summary is coming when one actually is. A thread that was
      // already dormant when the plugin arrived is never backfilled, so it sits
      // at `absent` until someone asks for a brief.
      return isPending(threadId) ? { state: "summarizing" } : { state: "absent" };
    }
    return { state: "ready", brief: resolveBrief(stored) };
  };

  // ------------------------------------------------------------------- rpc

  bb.rpc.register(rpcContract, {
    getBrief: ({ threadId }) => briefState(threadId),

    listRowSignals: async () => {
      const keys = await bb.storage.kv.list("brief:");
      const signals: RowSignal[] = [];
      for (const key of keys) {
        const stored = await readBrief(threadIdFromKey(key));
        if (stored === null) continue;
        // No live thread lookups here: the client folds the running/queued
        // override in per row, off the sidebar view it already has.
        signals.push(rowSignalFor(resolveBrief(stored)));
      }
      return { signals };
    },

    setStageOverride: async ({ threadId, stage }) => {
      const stored = await readBrief(threadId);
      if (stored === null) return briefState(threadId);
      await writeBrief({
        ...stored,
        stageOverride: stage,
        // Anchor the override to the activity the user was looking at, so the
        // next real turn retires it.
        stageOverrideSeq: stage === null ? null : stored.lastActivitySeen,
      });
      announce();
      return briefState(threadId);
    },

    setStatusOverride: async ({ threadId, status }) => {
      const stored = await readBrief(threadId);
      if (stored === null) return briefState(threadId);
      await writeBrief({
        ...stored,
        statusOverride: status,
        // Anchored to the activity the user was looking at, so the next real
        // turn retires it — the same contract as the stage override.
        statusOverrideSeq: status === null ? null : stored.lastActivitySeen,
      });
      announce();
      // The status is what the sidebar sections are keyed on, so a pin has to
      // move the thread as well as its glyph. Debounced, so clicking through a
      // few threads is still one pass.
      scheduleReconcile();
      return briefState(threadId);
    },

    refresh: ({ threadId }) => {
      cancelSummary(threadId);
      // An explicit Re-summarize is a full brief, title included, even if a
      // pre-turn one was already queued for this thread.
      preTurn.delete(threadId);
      forced.add(threadId);
      enqueue(threadId);
      return { queued: true };
    },
  });

  // -------------------------------------------------------- sidebar sections

  const prefsResult = z.object({
    preferences: z.record(z.string(), z.unknown()),
  });
  const prefResult = z.object({ key: z.string(), value: z.unknown() });

  const readThreadListPrefs = async (): Promise<Record<string, unknown>> => {
    const result = await bb.sdk.plugins.callRpc({
      pluginId: THREAD_LIST_PLUGIN_ID,
      method: "listPreferences",
      input: null,
      outputSchema: prefsResult,
    });
    return result.preferences;
  };

  const writeThreadListPref = async (key: string, value: JsonValue) => {
    await bb.sdk.plugins.callRpc({
      pluginId: THREAD_LIST_PLUGIN_ID,
      method: "setPreference",
      input: { key, value },
      outputSchema: prefResult,
    });
  };

  const resetThreadListPref = async (key: string) => {
    await bb.sdk.plugins.callRpc({
      pluginId: THREAD_LIST_PLUGIN_ID,
      method: "resetPreference",
      input: { key },
      outputSchema: prefResult,
    });
  };

  const readSidebarState = async (): Promise<SidebarGroupingState> =>
    (await bb.storage.kv.get<SidebarGroupingState>(SIDEBAR_STATE_KEY)) ?? {
      applied: false,
      previous: null,
    };

  /** Our sections in display order, creating any that are missing. */
  const ensureSections = async (): Promise<{ name: string; id: string }[]> => {
    const existing = await bb.sdk.threadSections.list();
    const byName = new Map(existing.map((section) => [section.name, section.id]));
    const sections: { name: string; id: string }[] = [];
    // Created in display order, so creation order — which is the order bb hands
    // sections to a sidebar — already agrees with `manualSectionOrder`.
    for (const name of SECTION_NAMES) {
      const id =
        byName.get(name) ?? (await bb.sdk.threadSections.create({ name })).id;
      sections.push({ name, id });
    }
    return sections;
  };

  /** Visible, live threads, in pages, capped. */
  const listGroupableThreads = async (): Promise<SectionedThread[]> => {
    const threads: SectionedThread[] = [];
    for (let offset = 0; offset < SECTION_THREAD_LIMIT; offset += SECTION_PAGE_SIZE) {
      const page = await bb.sdk.threads.list({
        limit: SECTION_PAGE_SIZE,
        offset,
      });
      for (const thread of page) {
        if (thread.visibility === "hidden") continue;
        // Archived threads are out regardless of status: the grouping is for
        // work still in front of you.
        if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
        threads.push({ id: thread.id, sectionId: thread.sectionId ?? null });
      }
      if (page.length < SECTION_PAGE_SIZE) break;
    }
    return threads;
  };

  /** Target section per thread, read from stored briefs only. */
  const sectionIdByThreadId = async (
    sectionIds: ReadonlyMap<string, string>,
  ): Promise<Map<string, string>> => {
    const targets = new Map<string, string>();
    for (const key of await bb.storage.kv.list("brief:")) {
      const threadId = threadIdFromKey(key);
      const stored = await readBrief(threadId);
      if (stored === null) continue;
      const name = sectionNameForStatus(storedStatus(stored));
      if (name === null) continue;
      const sectionId = sectionIds.get(name);
      if (sectionId !== undefined) targets.set(threadId, sectionId);
    }
    return targets;
  };

  /** Hand the sidebar back: delete our sections, restore what we changed. */
  async function teardownGrouping(state: SidebarGroupingState) {
    // Collected before the first delete: never iterate a list while mutating
    // what produced it.
    const ours = (await bb.sdk.threadSections.list())
      .filter((section) => SECTION_NAMES.includes(section.name))
      .map((section) => section.id);
    // Deleting a section removes its thread assignments, so the threads fall
    // back into bb's Threads group without a pass over them.
    for (const id of ours) {
      await bb.sdk.threadSections.delete({ id });
    }
    for (const key of [...Object.keys(GROUPED_PREFS), "manualSectionOrder"]) {
      const previous = state.previous?.[key];
      // Reset rather than guess when we never saw a prior value: thread-list
      // owns its own defaults and they can change without us.
      if (previous === undefined || previous === null) {
        await resetThreadListPref(key);
      } else {
        // Round-tripped through kv JSON, so this really is a JsonValue.
        await writeThreadListPref(key, previous as JsonValue);
      }
    }
    await bb.storage.kv.set(SIDEBAR_STATE_KEY, { applied: false, previous: null });
    bb.log.info("sidebar grouping off: sections removed, preferences restored");
  }

  /**
   * Reconcile every thread's section against its stored brief.
   *
   * Always a full pass rather than a per-thread update: one `threads.list` plus
   * one kv scan costs less than a `threads.get` per changed brief once a batch
   * is more than a handful, it is self-healing after a missed write, and it is
   * the same code path on startup as on a brief write. The debounce is what
   * turns a burst of brief writes into one pass, so the preference writes below
   * happen once per batch rather than once per thread.
   */
  async function reconcileSections() {
    const state = await readSidebarState();
    if ((await settings.get()).sidebarGrouping !== "status") {
      if (state.applied) await teardownGrouping(state);
      return;
    }

    const sections = await ensureSections();
    const sectionIds = new Map(sections.map(({ name, id }) => [name, id]));
    const desired: Record<string, JsonValue> = {
      ...GROUPED_PREFS,
      manualSectionOrder: manualSectionOrder(sections.map(({ id }) => id)),
    };

    const prefs = await readThreadListPrefs();
    if (!state.applied) {
      await bb.storage.kv.set(SIDEBAR_STATE_KEY, {
        applied: true,
        previous: Object.fromEntries(
          Object.keys(desired).map((key) => [key, prefs[key] ?? null]),
        ),
      });
    }
    for (const [key, value] of Object.entries(desired)) {
      // Only write a preference that is actually wrong, so a settled sidebar
      // costs no writes and a user's own sort choice is not re-stomped hourly.
      if (JSON.stringify(prefs[key]) !== JSON.stringify(value)) {
        await writeThreadListPref(key, value);
      }
    }

    const moves = planAssignments({
      threads: await listGroupableThreads(),
      sectionIdByThreadId: await sectionIdByThreadId(sectionIds),
      ownedSectionIds: new Set(sectionIds.values()),
    });
    for (const move of moves) {
      await bb.sdk.threads
        .update({ threadId: move.threadId, sectionId: move.sectionId })
        .catch((error: unknown) => {
          bb.log.warn(
            `could not move ${move.threadId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }
    if (moves.length > 0) {
      bb.log.info(`sidebar grouping: moved ${moves.length} thread(s)`);
    }
  }

  let sectionTimer: ReturnType<typeof setTimeout> | null = null;
  let reconciling = false;
  let reconcileAgain = false;

  async function runReconcile() {
    if (reconciling) {
      // A brief landed mid-pass; its thread would be missed otherwise.
      reconcileAgain = true;
      return;
    }
    reconciling = true;
    try {
      do {
        reconcileAgain = false;
        await reconcileSections();
      } while (reconcileAgain && !lifetime.signal.aborted);
    } catch (error) {
      bb.log.warn(
        `sidebar grouping failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      reconciling = false;
    }
  }

  /** Coalesce a burst of brief writes into one reconcile. */
  const scheduleReconcile = () => {
    if (sectionTimer !== null) clearTimeout(sectionTimer);
    sectionTimer = setTimeout(() => {
      sectionTimer = null;
      void runReconcile();
    }, SECTION_SYNC_DEBOUNCE_MS);
    sectionTimer.unref?.();
  };

  // A grouping that is turned on or off should take effect without a reload;
  // `reconcileSections` reads the setting itself and tears down when it is off.
  settings.onChange((next, prev) => {
    if (next.sidebarGrouping !== prev.sidebarGrouping) void runReconcile();
  });

  // ---------------------------------------------------------------- events

  bb.events.on("thread.idle", ({ thread }) => {
    // A turn boundary has been reached, so whatever we write now is a real
    // brief and may name the thread.
    preTurn.delete(thread.id);
    void (async () => {
      const values = await settings.get();
      // A thread with no brief yet skips the quiet period: nothing is being
      // protected from re-summarizing, and the empty state is what makes the
      // plugin feel unresponsive. See {@link FIRST_BRIEF_DELAY_MS}.
      const quietMs = Math.max(1, values.quietSeconds) * 1000;
      const first = (await readBrief(thread.id)) === null;
      scheduleSummary(thread.id, first ? firstBriefDelayMs(quietMs) : quietMs);
    })();
  });

  bb.events.on("thread.active", ({ thread }) => {
    // A summary already pending on this thread was scheduled by a `thread.idle`,
    // so a turn has ended and its brief is entitled to name the thread. Read
    // before the cancel below clears it.
    const afterATurn = isPending(thread.id);
    // A thread that started running again is not quiet; let the next idle
    // restart its debounce rather than summarizing mid-turn.
    cancelSummary(thread.id);
    if (thread.visibility === "hidden") return;
    void (async () => {
      const values = await settings.get();
      if (typeof values.apiKey !== "string" || values.apiKey.trim() === "") return;
      // Except on a thread with no brief at all: the opening prompt is enough
      // for a goal, a discovery-stage ring and a sidebar section, and waiting
      // for the turn to end means a long first turn spends its whole length
      // looking like a thread the plugin has never heard of. Every field is
      // corrected by the summary that follows the turn.
      if ((await readBrief(thread.id)) !== null) return;
      if (!afterATurn) preTurn.add(thread.id);
      scheduleSummary(
        thread.id,
        firstBriefDelayMs(Math.max(1, values.quietSeconds) * 1000),
      );
    })();
  });

  // The thread now wants something from the user. No new summary is needed —
  // status is derived — but the sidebar should repaint.
  bb.events.on("interaction.pending", () => {
    announce();
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    cancelSummary(thread.id);
    preTurn.delete(thread.id);
    void deleteBrief(thread.id).then(announce);
  });

  // ---------------------------------------------------------------- sweep

  /**
   * Backstop for activity whose `thread.idle` never reached us: the server was
   * restarting, the plugin was reloading, or the turn ended in an error rather
   * than idle. Cheap because it compares stored cursors and only summarizes
   * threads that actually moved.
   */
  bb.background.schedule("brief-sweep", SWEEP_CRON, async () => {
    const values = await settings.get();
    if (typeof values.apiKey !== "string" || values.apiKey.trim() === "") return;

    const threads = await bb.sdk.threads.list({ limit: SWEEP_LIMIT });
    const quietBefore = Date.now() - Math.max(1, values.quietSeconds) * 1000;

    for (const thread of threads) {
      if (thread.visibility === "hidden") continue;
      if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
      if (thread.status === "active" || thread.status === "starting") continue;
      if (thread.updatedAt > quietBefore) continue;
      if (debounces.has(thread.id) || queue.includes(thread.id)) continue;

      const stored = await readBrief(thread.id);
      if (stored === null) {
        // Briefs are never backfilled. A thread gets its first brief from
        // activity — `thread.idle` while we are running — so the sweep only
        // considers a briefless thread whose activity postdates this load,
        // which is activity whose event we should have seen and may have
        // missed. Anything older stays briefless until it is next worked on.
        //
        // Without this bound every briefless thread would be re-enqueued on
        // every sweep forever: an unbounded burst across the whole thread list
        // the first time a key is configured, and an endless ten-minute retry
        // for any thread whose summary keeps failing.
        if (thread.updatedAt > loadedAt) enqueue(thread.id);
        continue;
      }
      // A stored brief older than the thread's last activity means activity we
      // missed. `summarizeThread` re-checks the real cursor before spending a
      // request.
      if (stored.lastSummarizedAt < thread.updatedAt) enqueue(thread.id);
    }
  });

  // Reconcile once on startup: briefs may have changed while this plugin was
  // not running, and a section a thread was moved out of by hand is put back.
  void runReconcile();

  bb.onDispose(() => {
    lifetime.abort();
    for (const timer of debounces.values()) clearTimeout(timer);
    debounces.clear();
    if (sectionTimer !== null) clearTimeout(sectionTimer);
    queue.length = 0;
    forced.clear();
    preTurn.clear();
  });
}

// Re-exported for tests that exercise the derivation without a server.
export { deriveStatus };
export type { BriefStage };
