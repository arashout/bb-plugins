import { describe, expect, it } from "vitest";
import {
  deriveStatus,
  effectiveStage,
  isStageOverrideStale,
  planRename,
  resolveBrief,
  rowDecoration,
  rowSignalFor,
} from "./brief.js";
import { isLiveWorking } from "./shared.js";
import type { StoredBrief } from "./contract.js";

const stored = (overrides: Partial<StoredBrief> = {}): StoredBrief => ({
  version: 1,
  threadId: "thr_1",
  fields: {
    goal: "Ship the briefs plugin",
    currentState: "Server and app entries written",
    nextStep: "Run the vitest suite",
    blockedOn: "",
    constraints: "",
  },
  modelStage: "implementation",
  stageOverride: null,
  stageOverrideSeq: null,
  endedWithQuestion: false,
  lastSummarizedAt: 1_000,
  lastActivitySeen: 50,
  ...overrides,
});

describe("deriveStatus", () => {
  it("reports done only when nothing is outstanding and nothing blocking", () => {
    expect(deriveStatus({ nextStep: "   ", blockedOn: "" })).toBe("done");
  });

  it("does not call a blocked thread done, whatever the next step says", () => {
    // The prompt promises a non-empty nextStep whenever anything is
    // outstanding. This is the guard for when it does not deliver one.
    expect(deriveStatus({ nextStep: "", blockedOn: "Review from Dylan" })).toBe(
      "waiting-on-other",
    );
    expect(deriveStatus({ nextStep: "  ", blockedOn: "  Upstream fix " })).toBe(
      "waiting-on-other",
    );
  });

  it("reports waiting-on-other when something is blocking", () => {
    expect(
      deriveStatus({ nextStep: "Merge it", blockedOn: "Review from Dylan" }),
    ).toBe("waiting-on-other");
  });

  it("falls back to waiting-on-me for unfinished, unblocked work", () => {
    expect(deriveStatus({ nextStep: "Pick an approach", blockedOn: "" })).toBe(
      "waiting-on-me",
    );
  });

  it("does not need a trailing question to report waiting-on-me", () => {
    // An idle thread with work left needs a human look either way, so the
    // question signal no longer changes the outcome.
    expect(deriveStatus({ nextStep: "Keep going", blockedOn: "" })).toBe(
      "waiting-on-me",
    );
  });
});

describe("deriveStatus with an actor", () => {
  it("treats an external actor as blocked even with no blockedOn text", () => {
    expect(
      deriveStatus({
        nextStep: "Land the upstream PR",
        blockedOn: "",
        nextStepActor: "other",
      }),
    ).toBe("waiting-on-other");
  });

  it("reports waiting-on-me for a step only the user can take", () => {
    expect(
      deriveStatus({
        nextStep: "Try it and say whether the glyph looks right",
        blockedOn: "",
        nextStepActor: "me",
      }),
    ).toBe("waiting-on-me");
  });

  it("reports waiting-on-me for a step the agent could take, since the nudge is ours", () => {
    expect(
      deriveStatus({
        nextStep: "Keep porting the remaining call sites",
        blockedOn: "",
        nextStepActor: "agent",
      }),
    ).toBe("waiting-on-me");
  });

  it("lets done win over any actor, so a finished thread is never a prompt", () => {
    expect(
      deriveStatus({ nextStep: "", blockedOn: "", nextStepActor: "other" }),
    ).toBe("done");
  });

  it("preserves the actor-free behaviour when the actor is absent", () => {
    // Every brief written before this field existed lands here.
    expect(deriveStatus({ nextStep: "Keep going", blockedOn: "" })).toBe(
      deriveStatus({
        nextStep: "Keep going",
        blockedOn: "",
        nextStepActor: undefined,
      }),
    );
    expect(
      deriveStatus({
        nextStep: "Keep going",
        blockedOn: "",
        nextStepActor: undefined,
      }),
    ).toBe("waiting-on-me");
  });
});

describe("isLiveWorking", () => {
  it("is true for a running or queued thread", () => {
    expect(isLiveWorking("active")).toBe(true);
    expect(isLiveWorking("starting")).toBe(true);
    expect(isLiveWorking("pending")).toBe(true);
  });

  it("is false for an idle thread, and for anything it does not know", () => {
    expect(isLiveWorking("idle")).toBe(false);
    expect(isLiveWorking("error")).toBe(false);
    expect(isLiveWorking("stopping")).toBe(false);
    expect(isLiveWorking("something-new")).toBe(false);
  });
});

describe("stage overrides", () => {
  it("uses the model's stage when nothing is overridden", () => {
    expect(effectiveStage(stored())).toBe("implementation");
  });

  it("honours an override set at the current activity cursor", () => {
    const brief = stored({
      stageOverride: "review",
      stageOverrideSeq: 50,
      lastActivitySeen: 50,
    });
    expect(effectiveStage(brief)).toBe("review");
    expect(isStageOverrideStale(brief)).toBe(false);
  });

  it("retires an override once the thread has real new activity", () => {
    const brief = stored({
      stageOverride: "review",
      stageOverrideSeq: 50,
      lastActivitySeen: 51,
    });
    expect(isStageOverrideStale(brief)).toBe(true);
    expect(effectiveStage(brief)).toBe("implementation");
  });

  it("hides a retired override from the stage control", () => {
    const resolved = resolveBrief(
      stored({
        stageOverride: "review",
        stageOverrideSeq: 50,
        lastActivitySeen: 51,
      }),
    );
    expect(resolved.stageOverride).toBeNull();
    expect(resolved.stage).toBe("implementation");
  });
});

describe("rowDecoration", () => {
  const signalFor = (brief: StoredBrief) => rowSignalFor(resolveBrief(brief));

  const blocked = stored({
    fields: { ...stored().fields, blockedOn: "Waiting on CI" },
  });
  const done = stored({
    fields: { ...stored().fields, nextStep: "", blockedOn: "" },
  });

  it("draws the waiting-on-me glyph for an idle thread with work left", () => {
    const decoration = rowDecoration(signalFor(stored()), false);
    expect(decoration?.icon).toBe("MessageQuestion");
    expect(decoration?.label).toBe("Waiting on you — Implementation");
  });

  it("draws the blocked glyph for a thread waiting on someone else", () => {
    expect(rowDecoration(signalFor(blocked), false)?.icon).toBe("Pause");
  });

  it("draws the done glyph for a finished thread", () => {
    const decoration = rowDecoration(signalFor(done), false);
    expect(decoration?.icon).toBe("CircleCheck");
    expect(decoration?.tone).toBe("success");
  });

  it("draws nothing while the agent is running, whatever the brief says", () => {
    // Live working outranks the stored status, and working draws no glyph so
    // bb's own running indicator keeps the row.
    expect(rowDecoration(signalFor(blocked), true)).toBeNull();
    expect(rowDecoration(signalFor(done), true)).toBeNull();
    expect(rowDecoration(signalFor(stored()), true)).toBeNull();
  });

  it("restores the stored glyph once the thread goes idle again", () => {
    expect(rowDecoration(signalFor(blocked), false)?.icon).toBe("Pause");
  });
});

describe("planRename", () => {
  it("takes over bb's opening-prompt title the first time", () => {
    // `applied: null` is "we have never written one", so whatever is there is
    // bb's guess and replacing it is the whole point.
    expect(
      planRename({
        current: "The thread brief plugin generates some useful or...",
        desired: "Thread brief thread titles",
        applied: null,
      }),
    ).toBe("Thread brief thread titles");
  });

  it("titles a thread that never got one", () => {
    expect(
      planRename({ current: null, desired: "Kploy image tracking", applied: null }),
    ).toBe("Kploy image tracking");
  });

  it("updates a title it wrote itself", () => {
    expect(
      planRename({
        current: "Sidebar status grouping",
        desired: "Sidebar grouping teardown",
        applied: "Sidebar status grouping",
      }),
    ).toBe("Sidebar grouping teardown");
  });

  it("writes nothing when the thread already shows the name", () => {
    expect(
      planRename({
        current: "Sidebar status grouping",
        desired: "Sidebar status grouping",
        applied: "Sidebar status grouping",
      }),
    ).toBeNull();
  });

  it("stops renaming once someone renames the thread by hand", () => {
    expect(
      planRename({
        current: "DO NOT TOUCH — release cut",
        desired: "Sidebar grouping teardown",
        applied: "Sidebar status grouping",
      }),
    ).toBeNull();
  });

  it("stays stopped, because the caller leaves `applied` where it was", () => {
    // The next summary proposes something new again. Nothing was recorded when
    // the rename was skipped, so the mismatch is still there and still wins —
    // which is what makes the stop permanent without a flag to store.
    expect(
      planRename({
        current: "DO NOT TOUCH — release cut",
        desired: "A third suggestion entirely",
        applied: "Sidebar status grouping",
      }),
    ).toBeNull();
  });

  it("backs off when the title moved while the summary was running", () => {
    // The first rename has no `applied` to compare against, so this is the
    // only thing standing between a mid-summary rename and being overwritten.
    expect(
      planRename({
        current: "Renamed mid-flight",
        observed: "Build me a thing that does...",
        desired: "Sidebar grouping teardown",
        applied: null,
      }),
    ).toBeNull();
  });

  it("proceeds when the title held still for the whole summary", () => {
    expect(
      planRename({
        current: "Build me a thing that does...",
        observed: "Build me a thing that does...",
        desired: "Sidebar grouping teardown",
        applied: null,
      }),
    ).toBe("Sidebar grouping teardown");
  });

  it("leaves the title alone when the model proposed nothing usable", () => {
    expect(
      planRename({ current: "Sidebar grouping", desired: undefined, applied: null }),
    ).toBeNull();
    expect(
      planRename({ current: "Sidebar grouping", desired: "   ", applied: null }),
    ).toBeNull();
  });

  it("does not count whitespace as a hand-rename", () => {
    expect(
      planRename({
        current: "  Sidebar status grouping  ",
        desired: "Sidebar grouping teardown",
        applied: "Sidebar status grouping",
      }),
    ).toBe("Sidebar grouping teardown");
  });
});
