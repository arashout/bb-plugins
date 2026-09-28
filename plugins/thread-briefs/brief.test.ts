import { describe, expect, it } from "vitest";
import {
  deriveStatus,
  effectiveStage,
  isStageOverrideStale,
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
