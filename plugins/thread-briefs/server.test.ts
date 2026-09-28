import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import type { BriefState, StoredBrief } from "./contract.js";

const SUMMARY = {
  goal: "Ship the thread-briefs plugin",
  currentState: "Server, app and tests written",
  nextStep: "Push the branch and install from git",
  blockedOn: "",
  constraints: "bb exposes no additive per-row sidebar slot",
  stage: "review",
};

function fakeCompletion(body: unknown) {
  // Params are declared so `mock.calls` is a typed tuple, not `[]`.
  return vi.fn(async (_url: string, _init: RequestInit) =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(body) } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

const thread = makeThreadResponse({
  id: "thr_1",
  title: "Thread briefs",
  visibility: "visible",
  status: "idle",
});

function host(options: { fetch: ReturnType<typeof fakeCompletion> }) {
  globalThis.fetch = options.fetch as unknown as typeof globalThis.fetch;
  return createFakePluginHost({
    pluginId: "thread-briefs",
    settings: {
      apiKey: "test-key",
      baseUrl: "https://api.test/v1",
      model: "test-model",
      jsonMode: true,
      quietSeconds: 120,
    },
    sdk: {
      threads: {
        get: async () => thread,
        list: async () => [thread],
        output: async () => ({ output: "All set. Want me to push it?" }),
        conversationOutline: async () => ({
          items: [
            { id: "1", role: "user", preview: "Build a briefs plugin", attachmentSummary: null },
            { id: "2", role: "assistant", preview: "Done. Want me to push it?", attachmentSummary: null },
          ],
          maxSeq: 12,
        }),
        interactions: { list: async () => [] },
      },
    },
  });
}

/** A stored brief row, for seeding kv directly. */
function storedBrief(
  threadId: string,
  fields: Partial<StoredBrief["fields"]>,
): StoredBrief {
  return {
    version: 1,
    threadId,
    fields: {
      goal: "Ship sidebar grouping",
      currentState: "Sync written",
      nextStep: "Run the tests",
      blockedOn: "",
      constraints: "",
      ...fields,
    },
    modelStage: "implementation",
    stageOverride: null,
    stageOverrideSeq: null,
    endedWithQuestion: false,
    lastSummarizedAt: 1_000,
    lastActivitySeen: 12,
  };
}

/** The summarizer queue drains off the rpc call, so tests wait on its effect. */
async function waitFor<T>(read: () => Promise<T | null | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the summarizer");
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("registrations", () => {
  it("registers the rpc methods and the backstop sweep", async () => {
    const { bb, harness } = host({ fetch: fakeCompletion(SUMMARY) });
    await plugin(bb);

    expect(harness.registrations.rpcMethods).toEqual(
      expect.arrayContaining([
        "getBrief",
        "listRowSignals",
        "setStageOverride",
        "refresh",
      ]),
    );
    expect(harness.registrations.schedules.map((entry) => entry.name)).toContain(
      "brief-sweep",
    );
    await harness.lifecycle.dispose();
  });

  it("reports needs-configuration without an API key", async () => {
    globalThis.fetch = fakeCompletion(SUMMARY) as unknown as typeof globalThis.fetch;
    const { bb, harness } = createFakePluginHost({
      pluginId: "thread-briefs",
      settings: {},
    });
    await plugin(bb);
    expect(harness.needsConfigurationMessages.join(" ")).toMatch(/apiKey/u);
    await harness.lifecycle.dispose();
  });
});

describe("summarizing", () => {
  let current: Awaited<ReturnType<typeof host>> | null = null;

  beforeEach(() => {
    current = null;
  });

  afterEach(async () => {
    await current?.harness.lifecycle.dispose();
  });

  it("summarizes on refresh and serves the brief over rpc", async () => {
    const fetchMock = fakeCompletion(SUMMARY);
    current = host({ fetch: fetchMock });
    await plugin(current.bb);

    await current.harness.behavior.callRpc("refresh", { threadId: "thr_1" });

    const state = await waitFor(async () => {
      const result = (await current!.harness.behavior.callRpc("getBrief", {
        threadId: "thr_1",
      })) as BriefState;
      return result.state === "ready" ? result : null;
    });

    expect(state.state).toBe("ready");
    if (state.state !== "ready") throw new Error("unreachable");
    expect(state.brief.goal).toBe(SUMMARY.goal);
    expect(state.brief.stage).toBe("review");
    // A next step exists and nothing blocks it, but the agent's last message
    // ended in a question.
    expect(state.brief.status).toBe("waiting-on-me");

    // The request went where the settings pointed it.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.test/v1/chat/completions");
    expect(JSON.parse(String(init.body)).model).toBe("test-model");
  });

  it("does not summarize a thread the moment it goes idle", async () => {
    const fetchMock = fakeCompletion(SUMMARY);
    current = host({ fetch: fetchMock });
    await plugin(current.bb);

    await current.harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: "done",
    });
    // The quiet period has to elapse first.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips a second request when the thread has not moved", async () => {
    const fetchMock = fakeCompletion(SUMMARY);
    current = host({ fetch: fetchMock });
    await plugin(current.bb);

    await current.harness.behavior.callRpc("refresh", { threadId: "thr_1" });
    await waitFor(async () => {
      const result = (await current!.harness.behavior.callRpc("getBrief", {
        threadId: "thr_1",
      })) as BriefState;
      return result.state === "ready" ? result : null;
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The sweep considers the thread but the activity cursor is unchanged.
    await current.harness.behavior.runSchedule("brief-sweep");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports absent, not summarizing, for a thread with no brief and none queued", async () => {
    current = host({ fetch: fakeCompletion(SUMMARY) });
    await plugin(current.bb);

    const state = (await current.harness.behavior.callRpc("getBrief", {
      threadId: "thr_1",
    })) as BriefState;
    // Saying "summarizing" here would be a lie the UI could never resolve.
    expect(state.state).toBe("absent");
  });

  it("reports summarizing only while work is actually pending", async () => {
    current = host({ fetch: fakeCompletion(SUMMARY) });
    await plugin(current.bb);

    // A queued refresh is genuinely pending.
    await current.harness.behavior.callRpc("refresh", { threadId: "thr_2" });
    const pending = (await current.harness.behavior.callRpc("getBrief", {
      threadId: "thr_2",
    })) as BriefState;
    expect(["summarizing", "ready"]).toContain(pending.state);
  });

  it("never backfills a thread whose last activity predates this load", async () => {
    const fetchMock = fakeCompletion(SUMMARY);
    const stale = makeThreadResponse({
      id: "thr_old",
      title: "Ancient",
      visibility: "visible",
      status: "idle",
      // Last touched well before the plugin started: no activity to react to.
      updatedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    current = createFakePluginHost({
      pluginId: "thread-briefs",
      settings: { apiKey: "test-key", baseUrl: "https://api.test/v1" },
      sdk: {
        threads: {
          get: async () => stale,
          list: async () => [stale],
          output: async () => ({ output: "old" }),
          conversationOutline: async () => ({
            items: [
              { id: "1", role: "user", preview: "old work", attachmentSummary: null },
            ],
            maxSeq: 3,
          }),
          interactions: { list: async () => [] },
        },
      },
    }) as typeof current;
    await plugin(current!.bb);

    await current!.harness.behavior.runSchedule("brief-sweep");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchMock).not.toHaveBeenCalled();
    const state = (await current!.harness.behavior.callRpc("getBrief", {
      threadId: "thr_old",
    })) as BriefState;
    expect(state.state).toBe("absent");
  });

  it("gives a long-dormant thread a brief once it sees activity", async () => {
    // The whole point of not backfilling: dormant costs nothing, and the next
    // turn is what earns a brief.
    const fetchMock = fakeCompletion(SUMMARY);
    const old = makeThreadResponse({
      id: "thr_1",
      title: "Dormant for months",
      visibility: "visible",
      status: "idle",
      updatedAt: Date.now() - 90 * 24 * 60 * 60 * 1000,
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    current = createFakePluginHost({
      pluginId: "thread-briefs",
      settings: { apiKey: "test-key", baseUrl: "https://api.test/v1", quietSeconds: 1 },
      sdk: {
        threads: {
          get: async () => old,
          list: async () => [old],
          output: async () => ({ output: "Picked this back up." }),
          conversationOutline: async () => ({
            items: [
              { id: "1", role: "user", preview: "resume this", attachmentSummary: null },
            ],
            maxSeq: 9,
          }),
          interactions: { list: async () => [] },
        },
      },
    }) as typeof current;
    await plugin(current!.bb);

    // Nothing from the sweep, because nothing has happened.
    await current!.harness.behavior.runSchedule("brief-sweep");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).not.toHaveBeenCalled();

    // Now the thread is worked on again.
    await current!.harness.behavior.emitThreadEvent("thread.idle", {
      thread: old,
      lastAssistantText: "Picked this back up.",
    });
    const state = await waitFor(async () => {
      const result = (await current!.harness.behavior.callRpc("getBrief", {
        threadId: "thr_1",
      })) as BriefState;
      return result.state === "ready" ? result : null;
    });
    if (state.state !== "ready") throw new Error("unreachable");
    expect(state.brief.goal).toBe(SUMMARY.goal);
  });

  it("catches a briefless thread whose activity postdates this load", async () => {
    // The sweep's one job for a briefless thread: activity that happened while
    // we were running, whose `thread.idle` we apparently missed.
    const fetchMock = fakeCompletion(SUMMARY);
    let sweepThread = makeThreadResponse({ id: "thr_live", status: "idle" });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    current = createFakePluginHost({
      pluginId: "thread-briefs",
      // A 1s quiet period keeps the test fast.
      settings: { apiKey: "test-key", baseUrl: "https://api.test/v1", quietSeconds: 1 },
      sdk: {
        threads: {
          get: async () => sweepThread,
          list: async () => [sweepThread],
          output: async () => ({ output: "progress" }),
          conversationOutline: async () => ({
            items: [
              { id: "1", role: "user", preview: "do it", attachmentSummary: null },
            ],
            maxSeq: 4,
          }),
          interactions: { list: async () => [] },
        },
      },
    }) as typeof current;
    await plugin(current!.bb);

    // Activity just after load, then let the quiet period elapse.
    sweepThread = makeThreadResponse({
      id: "thr_live",
      status: "idle",
      updatedAt: Date.now() + 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));

    await current!.harness.behavior.runSchedule("brief-sweep");
    await waitFor(async () => (fetchMock.mock.calls.length > 0 ? true : null));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves a thread still inside its quiet period alone", async () => {
    // `thread` defaults to updatedAt = now, so the sweep must not touch it.
    const fetchMock = fakeCompletion(SUMMARY);
    current = host({ fetch: fetchMock });
    await plugin(current.bb);

    await current.harness.behavior.runSchedule("brief-sweep");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("emits a row signal per stored brief", async () => {
    current = host({ fetch: fakeCompletion(SUMMARY) });
    await plugin(current.bb);

    await current.harness.behavior.callRpc("refresh", { threadId: "thr_1" });
    const signals = await waitFor(async () => {
      const result = (await current!.harness.behavior.callRpc(
        "listRowSignals",
        null,
      )) as { signals: unknown[] };
      return result.signals.length > 0 ? result.signals : null;
    });
    expect(signals).toEqual([
      {
        threadId: "thr_1",
        status: "waiting-on-me",
        stage: "review",
        label: "Waiting on you — Review",
      },
    ]);
  });
});

describe("stage override", () => {
  it("pins the stage and retires it once the thread moves on", async () => {
    const fetchMock = fakeCompletion(SUMMARY);
    const { bb, harness } = host({ fetch: fetchMock });
    await plugin(bb);

    await harness.behavior.callRpc("refresh", { threadId: "thr_1" });
    await waitFor(async () => {
      const result = (await harness.behavior.callRpc("getBrief", {
        threadId: "thr_1",
      })) as BriefState;
      return result.state === "ready" ? result : null;
    });

    const overridden = (await harness.behavior.callRpc("setStageOverride", {
      threadId: "thr_1",
      stage: "planning",
    })) as BriefState;
    expect(overridden.state).toBe("ready");
    if (overridden.state !== "ready") throw new Error("unreachable");
    expect(overridden.brief.stage).toBe("planning");
    expect(overridden.brief.stageOverride).toBe("planning");

    // Simulate real new activity: the stored cursor falls behind the override's.
    const stored = await bb.storage.kv.get<StoredBrief>("brief:thr_1");
    await bb.storage.kv.set("brief:thr_1", {
      ...stored,
      lastActivitySeen: (stored?.stageOverrideSeq ?? 0) + 1,
    });

    const after = (await harness.behavior.callRpc("getBrief", {
      threadId: "thr_1",
    })) as BriefState;
    if (after.state !== "ready") throw new Error("unreachable");
    expect(after.brief.stage).toBe("review");
    expect(after.brief.stageOverride).toBeNull();

    await harness.lifecycle.dispose();
  });

  it("passes an in-force override to the summarizer as fixed", async () => {
    // The model is told discovery is wrong, but the user pinned it.
    const fetchMock = fakeCompletion({ ...SUMMARY, stage: "discovery" });
    const { bb, harness } = host({ fetch: fetchMock });
    await plugin(bb);

    await harness.behavior.callRpc("refresh", { threadId: "thr_1" });
    await waitFor(async () => {
      const result = (await harness.behavior.callRpc("getBrief", {
        threadId: "thr_1",
      })) as BriefState;
      return result.state === "ready" ? result : null;
    });
    await harness.behavior.callRpc("setStageOverride", {
      threadId: "thr_1",
      stage: "planning",
    });

    await harness.behavior.callRpc("refresh", { threadId: "thr_1" });
    await waitFor(async () => (fetchMock.mock.calls.length > 1 ? true : null));

    const body = JSON.parse(String(fetchMock.mock.calls[1]![1].body));
    expect(body.messages[1].content).toContain('"stage" is fixed to "planning"');

    const state = (await harness.behavior.callRpc("getBrief", {
      threadId: "thr_1",
    })) as BriefState;
    if (state.state !== "ready") throw new Error("unreachable");
    expect(state.brief.stage).toBe("planning");

    await harness.lifecycle.dispose();
  });
});

describe("sidebar grouping by status", () => {
  const groupedThread = (overrides: Partial<ReturnType<typeof makeThreadResponse>>) =>
    makeThreadResponse({ visibility: "visible", status: "idle", ...overrides });

  /**
   * A host with the sections surface stubbed, grouping already on, and the
   * `thread-list` preference RPC answered in memory so the test can see exactly
   * which preferences were written and how often.
   */
  function groupingHost(options: {
    threads: ReturnType<typeof makeThreadResponse>[];
    sections?: { id: string; name: string }[];
    grouping?: string;
  }) {
    const sections = options.sections ?? [];
    const prefs: Record<string, unknown> = {
      organizationMode: "project",
      chronologicalSort: "updated",
      manualSectionOrder: ["pinned", "sections", "threads"],
    };
    let nextSectionId = 1;

    globalThis.fetch = fakeCompletion(SUMMARY) as unknown as typeof globalThis.fetch;
    const created = createFakePluginHost({
      pluginId: "thread-briefs",
      settings: {
        apiKey: "test-key",
        baseUrl: "https://api.test/v1",
        model: "test-model",
        jsonMode: true,
        quietSeconds: 120,
        sidebarGrouping: options.grouping ?? "status",
      },
      sdk: {
        threads: {
          get: async ({ threadId }) =>
            options.threads.find((thread) => thread.id === threadId) ??
            options.threads[0]!,
          list: async (args) => ((args?.offset ?? 0) === 0 ? options.threads : []),
          update: async ({ threadId, sectionId }) => {
            const thread = options.threads.find((entry) => entry.id === threadId);
            if (thread !== undefined) {
              Object.assign(thread, { sectionId: sectionId ?? null });
            }
            return thread ?? options.threads[0]!;
          },
          output: async () => ({ output: "All set." }),
          conversationOutline: async () => ({ items: [], maxSeq: 0 }),
          interactions: { list: async () => [] },
        },
        threadSections: {
          list: async () => [...sections],
          create: async ({ name }) => {
            const section = { id: `sec_${nextSectionId++}`, name };
            sections.push(section);
            return { ...section, updatedThreadCount: 0 };
          },
          delete: async ({ id }) => {
            const index = sections.findIndex((section) => section.id === id);
            const [removed] = sections.splice(index, 1);
            return { id, name: removed?.name ?? "", updatedThreadCount: 0 };
          },
        },
        plugins: {
          callRpc: async ({ method, input }) => {
            if (method === "listPreferences") return { preferences: { ...prefs } };
            const { key, value } = input as { key: string; value?: unknown };
            if (method === "resetPreference") {
              delete prefs[key];
              return { key, value: null };
            }
            prefs[key] = value;
            return { key, value };
          },
        },
      },
    });
    return { ...created, prefs, sections };
  }

  /** The grouping reconcile is scheduled, so tests wait on its effect. */
  const settle = async (read: () => boolean) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (read()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("timed out waiting for the section sync");
  };

  it("creates the three sections and orders bb's Threads group last", async () => {
    const { bb, harness, prefs, sections } = groupingHost({ threads: [] });
    await plugin(bb);

    await settle(() => prefs.organizationMode === "chronological");
    expect(sections.map((section) => section.name)).toEqual([
      "Waiting on you",
      "Blocked",
      "Done",
    ]);
    expect(prefs.manualSectionOrder).toEqual([
      "pinned",
      "section:sec_1",
      "section:sec_2",
      "section:sec_3",
      "threads",
    ]);
    expect(prefs.chronologicalSort).toBe("updated");

    await harness.lifecycle.dispose();
  });

  it("files each thread by its brief's status and leaves briefless ones alone", async () => {
    const threads = [
      groupedThread({ id: "thr_wait", sectionId: null }),
      groupedThread({ id: "thr_blocked", sectionId: null }),
      groupedThread({ id: "thr_done", sectionId: null }),
      groupedThread({ id: "thr_nobrief", sectionId: null }),
    ];
    const { bb, harness } = groupingHost({ threads });
    await plugin(bb);

    await bb.storage.kv.set("brief:thr_wait", storedBrief("thr_wait", {}));
    await bb.storage.kv.set(
      "brief:thr_blocked",
      storedBrief("thr_blocked", { blockedOn: "Review from Dylan" }),
    );
    await bb.storage.kv.set(
      "brief:thr_done",
      storedBrief("thr_done", { nextStep: "", blockedOn: "" }),
    );

    await harness.behavior.callRpc("refresh", { threadId: "thr_wait" });
    await settle(() => threads[0]!.sectionId !== null);

    const sectionFor = (id: string) =>
      threads.find((thread) => thread.id === id)?.sectionId;
    expect(sectionFor("thr_wait")).toBe("sec_1");
    expect(sectionFor("thr_blocked")).toBe("sec_2");
    expect(sectionFor("thr_done")).toBe("sec_3");
    // No brief, so it stays unassigned and falls into bb's Threads group.
    expect(sectionFor("thr_nobrief")).toBeNull();

    await harness.lifecycle.dispose();
  });

  it("never files an archived thread, whatever its brief says", async () => {
    const threads = [
      groupedThread({ id: "thr_live", sectionId: null }),
      groupedThread({ id: "thr_old", sectionId: null, archivedAt: 1_000 }),
    ];
    const { bb, harness } = groupingHost({ threads });
    await plugin(bb);

    await bb.storage.kv.set("brief:thr_live", storedBrief("thr_live", {}));
    await bb.storage.kv.set("brief:thr_old", storedBrief("thr_old", {}));

    await harness.behavior.callRpc("refresh", { threadId: "thr_live" });
    await settle(() => threads[0]!.sectionId !== null);

    expect(threads[1]!.sectionId).toBeNull();
    expect(
      harness.sdk
        .callsTo("threads.update")
        .map(([args]) => (args as { threadId: string }).threadId),
    ).not.toContain("thr_old");

    await harness.lifecycle.dispose();
  });

  it("writes the preferences once per batch, not once per thread", async () => {
    const threads = Array.from({ length: 5 }, (_unused, index) =>
      groupedThread({ id: `thr_${index}`, sectionId: null }),
    );
    const { bb, harness } = groupingHost({ threads });
    await plugin(bb);

    for (const thread of threads) {
      await bb.storage.kv.set(`brief:${thread.id}`, storedBrief(thread.id, {}));
    }
    await harness.behavior.callRpc("refresh", { threadId: "thr_0" });
    await settle(() => threads.every((thread) => thread.sectionId !== null));

    // The debounce coalesces the batch: one listPreferences plus the three
    // preference writes that were actually wrong, and no more.
    const methods = harness.sdk
      .callsTo("plugins.callRpc")
      .map(([args]) => (args as { method: string }).method);
    expect(methods.filter((method) => method === "listPreferences")).toHaveLength(1);
    expect(methods.filter((method) => method === "setPreference")).toHaveLength(2);
    expect(threads).toHaveLength(5);

    await harness.lifecycle.dispose();
  });

  it("does nothing at all while grouping is off", async () => {
    const { bb, harness } = groupingHost({
      threads: [groupedThread({ id: "thr_1", sectionId: null })],
      grouping: "off",
    });
    await plugin(bb);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(harness.sdk.callsTo("threadSections.create")).toHaveLength(0);
    expect(harness.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
    expect(harness.sdk.callsTo("threads.update")).toHaveLength(0);

    await harness.lifecycle.dispose();
  });

  it("removes the sections and restores the preferences when turned off", async () => {
    const threads = [groupedThread({ id: "thr_1", sectionId: null })];
    const { bb, harness, prefs, sections } = groupingHost({ threads });
    await plugin(bb);

    await bb.storage.kv.set("brief:thr_1", storedBrief("thr_1", {}));
    await harness.behavior.callRpc("refresh", { threadId: "thr_1" });
    await settle(() => threads[0]!.sectionId !== null);

    await harness.behavior.setSettings({ sidebarGrouping: "off" });
    await settle(() => sections.length === 0);

    // Back to what the sidebar looked like before, not to a guess.
    expect(prefs.organizationMode).toBe("project");
    expect(prefs.manualSectionOrder).toEqual(["pinned", "sections", "threads"]);

    await harness.lifecycle.dispose();
  });
});

describe("stored rows written before nextStepActor", () => {
  it("keeps reading a row that has no actor, rather than discarding it", async () => {
    // `readBrief` deletes anything that fails the strict parse, and briefs are
    // never backfilled, so a required new field would wipe every existing brief
    // and leave dormant threads with nothing to regenerate from. This is the
    // test that says `nextStepActor` stays optional.
    const { bb, harness } = host({ fetch: fakeCompletion(SUMMARY) });
    await plugin(bb);

    await bb.storage.kv.set("brief:thr_1", {
      version: 1,
      threadId: "thr_1",
      fields: {
        goal: "Ship the thread-briefs plugin",
        currentState: "Server, app and tests written",
        nextStep: "Push the branch",
        blockedOn: "",
        constraints: "",
      },
      modelStage: "review",
      stageOverride: null,
      stageOverrideSeq: null,
      endedWithQuestion: false,
      lastSummarizedAt: 1_000,
      lastActivitySeen: 12,
    });

    const state = (await harness.behavior.callRpc("getBrief", {
      threadId: "thr_1",
    })) as BriefState;
    expect(state.state).toBe("ready");
    if (state.state !== "ready") throw new Error("unreachable");
    // No actor, so the derivation falls back to the actor-free behaviour.
    expect(state.brief.nextStepActor).toBeUndefined();
    expect(state.brief.status).toBe("waiting-on-me");
    expect(await bb.storage.kv.get("brief:thr_1")).not.toBeUndefined();

    await harness.lifecycle.dispose();
  });
});

describe("cleanup", () => {
  it("drops the brief when the thread is deleted", async () => {
    const { bb, harness } = host({ fetch: fakeCompletion(SUMMARY) });
    await plugin(bb);

    await harness.behavior.callRpc("refresh", { threadId: "thr_1" });
    await waitFor(async () => {
      const result = (await harness.behavior.callRpc("getBrief", {
        threadId: "thr_1",
      })) as BriefState;
      return result.state === "ready" ? result : null;
    });

    await harness.behavior.emitThreadEvent("thread.deleted", { thread });
    await waitFor(async () => {
      const keys = await bb.storage.kv.list("brief:");
      return keys.length === 0 ? true : null;
    });

    await harness.lifecycle.dispose();
  });
});
