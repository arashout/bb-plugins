// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot,
  type CapturedPluginApp,
  type RenderedSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type {
  PluginNavPanelRegistration,
  PluginSidebarProject,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { BriefCard, BriefState } from "./contract.js";

const NOW = Date.now();

const card = (overrides: Partial<BriefCard> = {}): BriefCard => ({
  threadId: "thr_1",
  stage: "implementation",
  modelStage: "implementation",
  status: "waiting-on-me",
  stageOverride: null,
  statusOverride: null,
  nextStep: "Push the branch",
  blockedOn: "",
  lastSummarizedAt: NOW - 1000,
  ...overrides,
});

const thread = (overrides: Partial<PluginSidebarThread>): PluginSidebarThread =>
  ({
    id: "thr_1",
    projectId: "proj_alpha",
    displayTitle: "Board thread",
    href: "/projects/proj_alpha/threads/thr_1",
    status: "idle",
    isPinned: false,
    isHidden: false,
    isArchived: false,
    latestAttentionAt: NOW - 1000,
    ...overrides,
  }) as PluginSidebarThread;

const project = (id: string, name: string): PluginSidebarProject =>
  ({ id, name, isPersonal: false }) as PluginSidebarProject;

const READY: BriefState = {
  state: "ready",
  brief: {
    threadId: "thr_1",
    goal: "Ship the board",
    currentState: "Columns render",
    nextStep: "Push the branch",
    blockedOn: "",
    constraints: "One slot per sidebar row",
    stage: "implementation",
    status: "waiting-on-me",
    stageOverride: null,
    statusOverride: null,
    lastSummarizedAt: NOW - 1000,
  },
};

let app: CapturedPluginApp | null = null;
const loadApp = async () => {
  app ??= await loadPluginApp(() => import("./app.js"));
  return app;
};

const panelOf = async (): Promise<PluginNavPanelRegistration> => {
  const captured = await loadApp();
  const panel = captured.navPanels[0];
  if (panel === undefined) throw new Error("no nav panel registered");
  return panel;
};

type RenderOptions = {
  subPath?: string;
  cards?: readonly BriefCard[];
  threads?: readonly PluginSidebarThread[];
  projects?: readonly PluginSidebarProject[];
  rpc?: Record<string, (input: never) => unknown>;
};

const renderBoard = async (options: RenderOptions = {}): Promise<RenderedSlot> => {
  const panel = await panelOf();
  return renderSlot(
    panel,
    { subPath: options.subPath ?? "" },
    {
      sidebarThreads: {
        status: "ready",
        threads: options.threads ?? [thread({})],
        projects: options.projects ?? [project("proj_alpha", "Alpha")],
        sections: [],
      },
      rpc: {
        listBriefCards: () => ({
          cards: options.cards ?? [card()],
          staleAfterMs: 24 * 60 * 60 * 1000,
          archiveAfterMs: 48 * 60 * 60 * 1000,
        }),
        getBrief: () => READY,
        setStageOverride: () => READY,
        setStatusOverride: () => READY,
        refresh: () => ({ queued: true }),
        ...options.rpc,
      } as never,
    },
  );
};

/** The column with this heading, so an assertion can be scoped to one bucket. */
const column = (slot: RenderedSlot, name: string) =>
  within(slot.getByRole("region", { name }));

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("registration", () => {
  it("registers one nav panel with a sidebar accessory", async () => {
    const captured = await loadApp();
    expect(captured.navPanels.map((entry) => entry.id)).toEqual(["board"]);
    const panel = captured.navPanels[0]!;
    expect(panel.path).toBe("board");
    expect(panel.title).toBe("Briefs");
    // The badge is the reason to open the board, so it has to be on the row.
    expect(panel.experimental_sidebarAccessory).toBeDefined();
  });
});

describe("the board", () => {
  it("draws every column, with the card in its stage", async () => {
    const slot = await renderBoard();
    await waitFor(() =>
      expect(column(slot, "Implementation").getByText("Board thread")).toBeTruthy(),
    );
    for (const name of [
      "No brief",
      "Discovery",
      "Planning",
      "Implementation",
      "Review",
      "Done",
    ]) {
      expect(slot.getByRole("region", { name })).toBeTruthy();
    }
    slot.lifecycle.unmount();
  });

  it("shows the next step on the card face, not the goal", async () => {
    // The board's question is which thread to pick up, not what a thread was
    // for; goal is one chevron away, where it answers the other question.
    const slot = await renderBoard();
    await waitFor(() => expect(slot.getByText("Push the branch")).toBeTruthy());
    expect(slot.queryByText("Ship the board")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("links the card at bb's own thread href", async () => {
    const slot = await renderBoard();
    const link = await waitFor(() =>
      slot.getByRole("link", { name: "Board thread" }),
    );
    expect(link.getAttribute("href")).toBe(
      "/projects/proj_alpha/threads/thr_1",
    );
    slot.lifecycle.unmount();
  });

  it("puts a done thread in the terminal column", async () => {
    const slot = await renderBoard({
      cards: [card({ status: "done", nextStep: "" })],
    });
    await waitFor(() =>
      expect(column(slot, "Done").getByText("Board thread")).toBeTruthy(),
    );
    expect(column(slot, "Done").getByText("Nothing outstanding.")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("puts a briefless thread in its own column and offers to summarize it", async () => {
    // Briefs are never backfilled, so the board has to account for these or it
    // cannot be read as "everything I have open".
    const slot = await renderBoard({ cards: [] });
    await waitFor(() =>
      expect(column(slot, "No brief").getByText("Board thread")).toBeTruthy(),
    );
    fireEvent.click(column(slot, "No brief").getByRole("button", { name: "Summarize" }));
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some((entry) => entry.method === "refresh"),
      ).toBe(true),
    );
    slot.lifecycle.unmount();
  });

  it("says when the agent could carry on by itself", async () => {
    const slot = await renderBoard({ cards: [card({ nextStepActor: "agent" })] });
    await waitFor(() => expect(slot.getByText("agent can continue")).toBeTruthy());
    slot.lifecycle.unmount();
  });

  it("marks a card pinned by hand", async () => {
    const slot = await renderBoard({
      cards: [card({ stageOverride: "implementation", modelStage: "planning" })],
    });
    await waitFor(() => expect(slot.getByText("· pinned")).toBeTruthy());
    slot.lifecycle.unmount();
  });

  it("warns that a cold done thread is on its way out", async () => {
    const slot = await renderBoard({
      cards: [card({ status: "done", nextStep: "" })],
      threads: [thread({ latestAttentionAt: NOW - 30 * 60 * 60 * 1000 })],
    });
    await waitFor(() => expect(slot.getByText("· archiving soon")).toBeTruthy());
    slot.lifecycle.unmount();
  });

  it("folds a running thread out of Done into its stage column", async () => {
    const slot = await renderBoard({
      cards: [card({ status: "done", nextStep: "" })],
      threads: [thread({ status: "active" })],
    });
    await waitFor(() =>
      expect(column(slot, "Implementation").getByText("Board thread")).toBeTruthy(),
    );
    expect(column(slot, "Done").queryByText("Board thread")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("redraws on a briefs-changed event", async () => {
    let status: BriefCard["status"] = "waiting-on-me";
    const slot = await renderBoard({
      rpc: {
        listBriefCards: () => ({
          cards: [card({ status, nextStep: status === "done" ? "" : "Push" })],
          staleAfterMs: 0,
          archiveAfterMs: 0,
        }),
      },
    });
    await waitFor(() =>
      expect(column(slot, "Implementation").getByText("Board thread")).toBeTruthy(),
    );
    status = "done";
    await slot.behavior.emitRealtime("briefs-changed", { at: 1 });
    await waitFor(() =>
      expect(column(slot, "Done").getByText("Board thread")).toBeTruthy(),
    );
    slot.lifecycle.unmount();
  });
});

describe("the filters", () => {
  it("puts a chosen status in the URL", async () => {
    const slot = await renderBoard();
    await waitFor(() => expect(slot.getByText("Board thread")).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: /Waiting on you/ }));
    expect(slot.inspection.navigateCalls).toEqual([
      {
        method: "toPluginPanel",
        path: "board",
        options: { subPath: "status:waiting-on-me" },
      },
    ]);
    slot.lifecycle.unmount();
  });

  it("reads the filter back out of the URL", async () => {
    const slot = await renderBoard({ subPath: "status:done" });
    await waitFor(() => expect(slot.getByRole("region", { name: "Done" })).toBeTruthy());
    // Only the columns a done filter can ever fill: an empty column under a
    // filter reads as "nothing here" when the filter is what emptied it.
    expect(slot.queryByRole("region", { name: "Implementation" })).toBeNull();
    expect(slot.queryByRole("region", { name: "No brief" })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("filters by project, and offers projects only when there is a choice", async () => {
    const single = await renderBoard();
    await waitFor(() => expect(single.getByText("Board thread")).toBeTruthy());
    expect(single.queryByRole("button", { name: /Alpha/ })).toBeNull();
    single.lifecycle.unmount();

    const slot = await renderBoard({
      threads: [
        thread({}),
        thread({
          id: "thr_2",
          projectId: "proj_beta",
          displayTitle: "Beta thread",
        }),
      ],
      cards: [card(), card({ threadId: "thr_2" })],
      projects: [project("proj_alpha", "Alpha"), project("proj_beta", "Beta")],
    });
    await waitFor(() => expect(slot.getByText("Beta thread")).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: /Beta/ }));
    expect(slot.inspection.navigateCalls).toEqual([
      {
        method: "toPluginPanel",
        path: "board",
        options: { subPath: "project:proj_beta" },
      },
    ]);
    slot.lifecycle.unmount();
  });

  it("restores the last filter on arriving at the panel root", async () => {
    window.localStorage.setItem("test-plugin:board-filters", "status:done");
    const slot = await renderBoard({ subPath: "" });
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toEqual([
        {
          method: "toPluginPanel",
          path: "board",
          options: { subPath: "status:done", replace: true },
        },
      ]),
    );
    slot.lifecycle.unmount();
  });

  it("does not override a filter already in the URL", async () => {
    window.localStorage.setItem("test-plugin:board-filters", "status:done");
    const slot = await renderBoard({ subPath: "status:working" });
    await waitFor(() => expect(slot.getByRole("region", { name: "Discovery" })).toBeTruthy());
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("clears back to the unfiltered board", async () => {
    const slot = await renderBoard({ subPath: "status:done" });
    await waitFor(() => expect(slot.getByRole("button", { name: "Clear" })).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Clear" }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toPluginPanel", path: "board", options: { subPath: "" } },
    ]);
    slot.lifecycle.unmount();
  });
});

describe("dragging a card", () => {
  /** One HTML5 drag, as the browser sequences it. */
  const drag = (slot: RenderedSlot, title: string, columnName: string) => {
    const cardElement = slot.getByText(title).closest("article");
    if (cardElement === null) throw new Error("no card");
    const dataTransfer = {
      setData: () => {},
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.dragStart(cardElement, { dataTransfer });
    const target = slot.getByRole("region", { name: columnName });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
  };

  it("pins the stage you drop it on", async () => {
    const slot = await renderBoard();
    await waitFor(() => expect(slot.getByText("Board thread")).toBeTruthy());
    drag(slot, "Board thread", "Review");
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.filter(
          (entry) => entry.method === "setStageOverride",
        ),
      ).toEqual([
        {
          method: "setStageOverride",
          input: { threadId: "thr_1", stage: "review" },
        },
      ]),
    );
    slot.lifecycle.unmount();
  });

  it("pins done when you drop it on the terminal column", async () => {
    const slot = await renderBoard();
    await waitFor(() => expect(slot.getByText("Board thread")).toBeTruthy());
    drag(slot, "Board thread", "Done");
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.filter(
          (entry) => entry.method === "setStatusOverride",
        ),
      ).toEqual([
        {
          method: "setStatusOverride",
          input: { threadId: "thr_1", status: "done" },
        },
      ]),
    );
    slot.lifecycle.unmount();
  });

  it("writes nothing when the card is dropped where it already is", async () => {
    const slot = await renderBoard();
    await waitFor(() => expect(slot.getByText("Board thread")).toBeTruthy());
    drag(slot, "Board thread", "Implementation");
    expect(
      slot.inspection.rpcCalls.filter((entry) =>
        entry.method.startsWith("set"),
      ),
    ).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("writes nothing when a briefless card is dragged", async () => {
    const slot = await renderBoard({ cards: [] });
    await waitFor(() => expect(slot.getByText("Board thread")).toBeTruthy());
    drag(slot, "Board thread", "Review");
    expect(
      slot.inspection.rpcCalls.filter((entry) =>
        entry.method.startsWith("set"),
      ),
    ).toEqual([]);
    slot.lifecycle.unmount();
  });
});

describe("the expanded card", () => {
  it("shows the rest of the brief and both pin controls", async () => {
    const slot = await renderBoard();
    await waitFor(() => expect(slot.getByText("Board thread")).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Show the whole brief" }));

    await waitFor(() => expect(slot.getByText("Ship the board")).toBeTruthy());
    expect(slot.getByText("Columns render")).toBeTruthy();
    expect(slot.getByText("One slot per sidebar row")).toBeTruthy();
    // The touch path: drag-and-drop is a pointer affordance, so the same two
    // writes have to be reachable as taps.
    expect(slot.getByRole("button", { name: "Review", pressed: false })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("pins a stage from the control", async () => {
    const slot = await renderBoard();
    await waitFor(() => expect(slot.getByText("Board thread")).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Show the whole brief" }));
    await waitFor(() => expect(slot.getByText("Ship the board")).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Review", pressed: false }));

    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.filter(
          (entry) => entry.method === "setStageOverride",
        ),
      ).toEqual([
        {
          method: "setStageOverride",
          input: { threadId: "thr_1", stage: "review" },
        },
      ]),
    );
    slot.lifecycle.unmount();
  });
});
