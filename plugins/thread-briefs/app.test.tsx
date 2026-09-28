// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
  type CapturedPluginApp,
} from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { BriefState, RowSignal } from "./contract.js";
import { BRIEFS_CHANGED_CHANNEL } from "./shared.js";

const READY: BriefState = {
  state: "ready",
  brief: {
    threadId: "thr_1",
    goal: "Ship the thread-briefs plugin",
    currentState: "Server and app written",
    nextStep: "Push the branch",
    // Empty fields must not render a heading.
    blockedOn: "",
    constraints: "bb has no additive per-row sidebar slot",
    stage: "review",
    status: "waiting-on-me",
    stageOverride: null,
    lastSummarizedAt: 1_000,
  },
};

const sidebarThread = (
  overrides: Partial<PluginSidebarThread>,
): PluginSidebarThread =>
  ({
    id: "thr_1",
    status: "idle",
    hasPendingInteraction: false,
    ...overrides,
  }) as PluginSidebarThread;

let app: CapturedPluginApp | null = null;
const loadApp = async () => {
  app ??= await loadPluginApp(() => import("./app.js"));
  return app;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registrations", () => {
  it("registers the overlay, panel action, header action and content script", async () => {
    const captured = await loadApp();
    expect(captured.appOverlays.map((entry) => entry.id)).toEqual(["brief-sync"]);
    expect(captured.threadPanelActions.map((entry) => entry.id)).toEqual(["brief"]);
    expect(captured.threadHeaderActions.map((entry) => entry.id)).toEqual(["brief"]);
    expect(captured.contentScripts.map((entry) => entry.id)).toEqual(["row-glyphs"]);
    // Nothing may register a thread list: replacing bb's sidebar is out of scope.
    expect(captured.threadLists).toEqual([]);
  });

  it("labels the tab the same way from the launcher as from the header", async () => {
    const captured = await loadApp();
    const action = captured.threadPanelActions[0]!;
    const opens: Array<string | undefined> = [];
    action.run!({
      threadId: "thr_1",
      openPanel: (options) => {
        opens.push(options?.title);
        return true;
      },
    });
    expect(opens).toEqual(["Brief"]);
  });
});

/**
 * The button holds no brief state: its whole job is to open the panel tab. That
 * is what keeps the brief one click from the same place on every thread, since
 * panel tabs are per-thread and per-device.
 */
describe("the header button", () => {
  const render = async (options: { isCompactViewport?: boolean } = {}) => {
    const captured = await loadApp();
    return renderSlot(
      captured.threadHeaderActions[0]!,
      {
        threadId: "thr_1",
        projectId: "proj_1",
        isCompactViewport: options.isCompactViewport ?? false,
      },
      { openThreadPanel: () => true },
    );
  };

  it("opens the brief panel tab", async () => {
    const slot = await render();
    fireEvent.click(await slot.findByRole("button", { name: "Thread brief" }));

    expect(slot.inspection.navigateCalls).toEqual([
      {
        method: "openThreadPanel",
        options: { actionId: "brief", title: "Brief" },
      },
    ]);
    slot.lifecycle.unmount();
  });

  it("never fetches a brief of its own", async () => {
    // The header mounts for every visible thread, including both panes of a
    // split; the panel mounts only while its tab is on screen.
    const slot = await render();
    fireEvent.click(await slot.findByRole("button", { name: "Thread brief" }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toEqual([]));
    slot.lifecycle.unmount();
  });

  it("drops the label on a compact viewport but keeps the control", async () => {
    const slot = await render({ isCompactViewport: true });
    expect(await slot.findByRole("button", { name: "Thread brief" })).toBeTruthy();
    expect(slot.queryByText("Brief")).toBeNull();
    slot.lifecycle.unmount();
  });
});

describe("the brief panel", () => {
  const render = async (options: {
    getBrief?: () => BriefState;
    setStageOverride?: (input: unknown) => BriefState;
    refresh?: () => { queued: boolean };
  }) => {
    const captured = await loadApp();
    return renderSlot(
      captured.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      {
        rpc: {
          getBrief: options.getBrief ?? (() => READY),
          setStageOverride: options.setStageOverride ?? (() => READY),
          refresh: options.refresh ?? (() => ({ queued: true })),
          listRowSignals: () => ({ signals: [] }),
        },
      },
    );
  };

  it("shows the populated fields and skips the empty ones", async () => {
    const slot = await render({});

    // No click anywhere: the tab being on screen is the request.
    expect(await slot.findByText("Ship the thread-briefs plugin")).toBeTruthy();
    expect(await slot.findByText("Server and app written")).toBeTruthy();
    expect(await slot.findByText("Push the branch")).toBeTruthy();
    expect(slot.queryByText("Blocked on")).toBeNull();
    expect(await slot.findByText("Waiting on you")).toBeTruthy();

    slot.lifecycle.unmount();
  });

  it("says how old the brief is, which a panel left open cannot assume", async () => {
    const slot = await render({
      getBrief: () => ({
        state: "ready",
        brief: { ...READY.brief!, lastSummarizedAt: Date.now() },
      }),
    });
    expect(await slot.findByText("Summarized just now")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("says so while a brief is still being summarized", async () => {
    const slot = await render({ getBrief: () => ({ state: "summarizing" }) });
    expect(await slot.findByText("Summarizing…")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("offers to summarize a thread that has no brief, rather than spinning", async () => {
    const slot = await render({ getBrief: () => ({ state: "absent" }) });

    expect(await slot.findByText("No brief for this thread yet.")).toBeTruthy();
    // A dormant thread is never backfilled, so "Summarizing…" would never resolve.
    expect(slot.queryByText("Summarizing…")).toBeNull();

    fireEvent.click(await slot.findByRole("button", { name: "Summarize now" }));
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some((call) => call.method === "refresh"),
      ).toBe(true),
    );
    slot.lifecycle.unmount();
  });

  it("surfaces the unconfigured message instead of an empty brief", async () => {
    const slot = await render({
      getBrief: () => ({ state: "unconfigured", message: "Add an API key." }),
    });
    expect(await slot.findByText("Add an API key.")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("reports a thread with no next step as done rather than inventing one", async () => {
    const slot = await render({
      getBrief: () => ({
        state: "ready",
        brief: { ...READY.brief!, nextStep: "", status: "done" },
      }),
    });
    expect(await slot.findByText("No next step — this thread reads as done.")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("reloads when the server announces a new brief", async () => {
    let goal = "Ship the thread-briefs plugin";
    const slot = await render({
      getBrief: () => ({ state: "ready", brief: { ...READY.brief!, goal } }),
    });
    expect(await slot.findByText(goal)).toBeTruthy();

    goal = "Move the brief into the side panel";
    await slot.behavior.emitRealtime(BRIEFS_CHANGED_CHANNEL, {});
    expect(await slot.findByText(goal)).toBeTruthy();

    slot.lifecycle.unmount();
  });

  it("sets a manual stage", async () => {
    const slot = await render({});
    fireEvent.click(await slot.findByRole("button", { name: "Planning" }));

    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some(
          (call) =>
            call.method === "setStageOverride" &&
            (call.input as { stage: string }).stage === "planning",
        ),
      ).toBe(true),
    );
    slot.lifecycle.unmount();
  });

  it("clears the override when the active manual stage is picked again", async () => {
    const overridden: BriefState = {
      state: "ready",
      brief: { ...READY.brief!, stage: "planning", stageOverride: "planning" },
    };
    const slot = await render({ getBrief: () => overridden });
    fireEvent.click(await slot.findByRole("button", { name: /Planning/u }));

    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some(
          (call) =>
            call.method === "setStageOverride" &&
            (call.input as { stage: string | null }).stage === null,
        ),
      ).toBe(true),
    );
    slot.lifecycle.unmount();
  });
});

describe("sidebar row glyphs", () => {
  const signal = (overrides: Partial<RowSignal> = {}): RowSignal => ({
    threadId: "thr_1",
    status: "done",
    stage: "review",
    label: "Done — Review",
    ...overrides,
  });

  /**
   * The overlay owns the data and the content script owns the setter, so a
   * realistic test mounts both against one loaded app.
   */
  const mountBoth = async (options: {
    signals: RowSignal[];
    threads?: PluginSidebarThread[];
    omitSetter?: boolean;
  }) => {
    const captured = await loadApp();
    const scripts = await mountPluginContentScripts(captured, {
      pluginId: "thread-briefs",
      ...(options.omitSetter === true
        ? { omitExperimentalThreadRowStatus: true }
        : {}),
    });
    const slot = renderSlot(
      captured.appOverlays[0]!,
      {},
      {
        rpc: { listRowSignals: () => ({ signals: options.signals }) },
        sidebarThreads: {
          threads: options.threads ?? [sidebarThread({ id: "thr_1" })],
        },
      },
    );
    return { scripts, slot };
  };

  it("paints the done glyph on the row", async () => {
    const { scripts, slot } = await mountBoth({ signals: [signal()] });

    await waitFor(() =>
      expect(scripts.inspection.getThreadRowStatus("thr_1")).toEqual({
        icon: "CircleCheck",
        label: "Done — Review",
        tone: "success",
      }),
    );

    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });

  it("leaves a running thread to bb's own indicator", async () => {
    // Live working outranks the brief, and working draws no glyph.
    const { scripts, slot } = await mountBoth({
      signals: [signal({ status: "waiting-on-other", label: "Blocked — Review" })],
      threads: [sidebarThread({ id: "thr_1", status: "active" })],
    });

    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
    expect(scripts.inspection.getThreadRowStatus("thr_1")).toBeNull();

    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });

  it("draws the brief's glyph once the thread is no longer running", async () => {
    const { scripts, slot } = await mountBoth({
      signals: [signal({ status: "waiting-on-me", label: "Waiting on you — Review" })],
      threads: [sidebarThread({ id: "thr_1", status: "idle" })],
    });

    await waitFor(() =>
      expect(scripts.inspection.getThreadRowStatus("thr_1")).toEqual({
        icon: "MessageQuestion",
        label: "Waiting on you — Review",
        tone: "default",
      }),
    );

    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });

  it("clears its glyphs on dispose", async () => {
    const { scripts, slot } = await mountBoth({ signals: [signal()] });
    await waitFor(() =>
      expect(scripts.inspection.getThreadRowStatus("thr_1")).not.toBeNull(),
    );

    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();

    // No glyph may survive the generation, whether the host cleared it or the
    // script's own disposer did.
    expect(scripts.inspection.getThreadRowStatus("thr_1")).toBeNull();
  });

  it("does not throw on a host without the row-status setter", async () => {
    const { scripts, slot } = await mountBoth({
      signals: [signal()],
      omitSetter: true,
    });
    expect(scripts.inspection.mountedIds).toEqual(["row-glyphs"]);
    expect(scripts.inspection.threadRowStatusCalls).toEqual([]);

    slot.lifecycle.unmount();
    await scripts.lifecycle.dispose();
  });
});
