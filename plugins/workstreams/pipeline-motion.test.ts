import { describe, expect, it } from "vitest";
import { changedPipelineMotionKeys, pipelineArrivalFrames, snapshotPipelineMotion } from "./pipeline-motion";
import type { PipelineCard } from "./pipeline";

function card(key: string, patch: Partial<PipelineCard> = {}): PipelineCard {
  return {
    key,
    stage: "review",
    blocker: { label: "Awaiting review", tone: "wait" },
    activity: { state: "none", detail: "", threadId: null, source: null },
    hold: null,
    ...patch,
  } as PipelineCard;
}

function snapshot(cards: PipelineCard[], contextKey = "stage||false") {
  return { contextKey, states: snapshotPipelineMotion(cards) };
}

describe("Pipeline arrival cues", () => {
  it("keeps the first scan and newly discovered cards still", () => {
    const first = snapshot([card("one")]);
    expect(changedPipelineMotionKeys(null, first).size).toBe(0);
    expect(changedPipelineMotionKeys(first, snapshot([card("one"), card("two")])).size).toBe(0);
  });

  it("ignores repeated polls and changing activity detail or timestamps", () => {
    const initial = snapshot([card("one")]);
    const later = snapshot([card("one", {
      activity: { state: "none", detail: "Updated 2 minutes ago", threadId: "thread", source: "run" },
      ageSince: Date.now(),
    })]);
    expect(changedPipelineMotionKeys(initial, later).size).toBe(0);
  });

  it("cues stage, blocker, activity state, and hold changes", () => {
    const initial = snapshot([card("stage"), card("blocker"), card("tone"), card("activity"), card("hold")]);
    const updated = snapshot([
      card("stage", { stage: "feedback" }),
      card("blocker", { blocker: { label: "CI failing", tone: "wait" } }),
      card("tone", { blocker: { label: "Awaiting review", tone: "bad" } }),
      card("activity", { activity: { state: "working", detail: "Running", threadId: null, source: "run" } }),
      card("hold", { hold: {} as PipelineCard["hold"] }),
    ]);
    expect(changedPipelineMotionKeys(initial, updated)).toEqual(new Set(["stage", "blocker", "tone", "activity", "hold"]));
  });

  it("resets on layout or filter switches even when card state also changes", () => {
    const initial = snapshot([card("one")]);
    const changed = [card("one", { stage: "ready" })];
    for (const contextKey of ["effort||false", "stage|query|false", "stage||true"]) {
      expect(changedPipelineMotionKeys(initial, snapshot(changed, contextKey)).size).toBe(0);
    }
    expect(changedPipelineMotionKeys(initial, snapshot([])).size).toBe(0);
  });

  it("ends a held card's cue at its muted destination opacity", () => {
    expect(pipelineArrivalFrames(0.55)).toEqual([
      { opacity: 0.55 * 0.75, transform: "translateY(4px)" },
      { opacity: 0.55, transform: "none" },
    ]);
  });
});
