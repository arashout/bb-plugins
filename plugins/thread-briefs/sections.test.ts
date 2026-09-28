import { describe, expect, it } from "vitest";
import {
  manualSectionOrder,
  planAssignments,
  sectionNameForStatus,
  storedStatus,
  SECTION_NAMES,
  STATUS_SECTIONS,
  type SectionedThread,
} from "./sections.js";
import type { BriefFields, StoredBrief } from "./contract.js";

const stored = (fields: Partial<BriefFields> = {}): StoredBrief => ({
  version: 1,
  threadId: "thr_1",
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
  lastActivitySeen: 50,
});

/** Section ids, as `ensureSections` would hand them over. */
const IDS = new Map([
  ["Waiting on you", "sec_wait"],
  ["Blocked", "sec_blocked"],
  ["Done", "sec_done"],
]);
const OWNED = new Set(IDS.values());

const plan = (
  threads: readonly SectionedThread[],
  targets: ReadonlyMap<string, string>,
) =>
  planAssignments({
    threads,
    sectionIdByThreadId: targets,
    ownedSectionIds: OWNED,
  });

describe("the section table", () => {
  it("covers every status a stored brief can have", () => {
    // `working` is live-only, so a section for it could never have members.
    // Every *other* status must have a section or its threads would silently
    // fall into the no-brief bucket.
    for (const status of ["waiting-on-me", "waiting-on-other", "done"] as const) {
      expect(sectionNameForStatus(status)).not.toBeNull();
    }
    expect(sectionNameForStatus("working")).toBeNull();
  });

  it("lists its names in display order", () => {
    expect(SECTION_NAMES).toEqual(["Waiting on you", "Blocked", "Done"]);
    expect(STATUS_SECTIONS.map((entry) => entry.status)).toEqual([
      "waiting-on-me",
      "waiting-on-other",
      "done",
    ]);
  });

  it("puts bb's own Threads group last, after our sections", () => {
    expect(manualSectionOrder(["a", "b", "c"])).toEqual([
      "pinned",
      "section:a",
      "section:b",
      "section:c",
      "threads",
    ]);
  });
});

describe("storedStatus", () => {
  it("maps each kind of brief to its section", () => {
    expect(sectionNameForStatus(storedStatus(stored()))).toBe("Waiting on you");
    expect(
      sectionNameForStatus(storedStatus(stored({ blockedOn: "Review" }))),
    ).toBe("Blocked");
    expect(
      sectionNameForStatus(
        storedStatus(stored({ nextStep: "", blockedOn: "" })),
      ),
    ).toBe("Done");
  });

  it("sends an external actor to Blocked even with no blockedOn text", () => {
    expect(
      sectionNameForStatus(storedStatus(stored({ nextStepActor: "other" }))),
    ).toBe("Blocked");
  });
});

describe("planAssignments", () => {
  it("moves a thread into the section its brief implies", () => {
    expect(
      plan([{ id: "thr_1", sectionId: null }], new Map([["thr_1", "sec_wait"]])),
    ).toEqual([{ threadId: "thr_1", sectionId: "sec_wait" }]);
  });

  it("leaves a thread that is already in the right section untouched", () => {
    expect(
      plan(
        [{ id: "thr_1", sectionId: "sec_wait" }],
        new Map([["thr_1", "sec_wait"]]),
      ),
    ).toEqual([]);
  });

  it("re-files a thread whose status changed", () => {
    expect(
      plan(
        [{ id: "thr_1", sectionId: "sec_wait" }],
        new Map([["thr_1", "sec_done"]]),
      ),
    ).toEqual([{ threadId: "thr_1", sectionId: "sec_done" }]);
  });

  it("leaves a briefless thread unassigned, for bb's Threads group", () => {
    expect(plan([{ id: "thr_1", sectionId: null }], new Map())).toEqual([]);
  });

  it("clears a stale assignment left by a brief that is gone", () => {
    expect(plan([{ id: "thr_1", sectionId: "sec_done" }], new Map())).toEqual([
      { threadId: "thr_1", sectionId: null },
    ]);
  });

  it("does not touch a thread the user filed in their own section", () => {
    // Overwriting a deliberate placement costs more than a catch-all is worth.
    expect(
      plan([{ id: "thr_1", sectionId: "sec_reading_list" }], new Map()),
    ).toEqual([]);
  });

  it("is idempotent: re-planning the result of a plan is empty", () => {
    const threads: SectionedThread[] = [
      { id: "thr_1", sectionId: null },
      { id: "thr_2", sectionId: "sec_wait" },
      { id: "thr_3", sectionId: "sec_done" },
    ];
    const targets = new Map([
      ["thr_1", "sec_wait"],
      ["thr_2", "sec_blocked"],
    ]);

    const first = plan(threads, targets);
    expect(first).toHaveLength(3);

    const applied = threads.map((thread) => {
      const move = first.find((candidate) => candidate.threadId === thread.id);
      return move === undefined ? thread : { ...thread, sectionId: move.sectionId };
    });
    expect(plan(applied, targets)).toEqual([]);
  });
});
