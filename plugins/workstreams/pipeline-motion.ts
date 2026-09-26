import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { EASE_CSS } from "./layout";
import type { PipelineCard } from "./pipeline";

type MotionState = {
  stage: PipelineCard["stage"];
  blockerLabel: string;
  blockerTone: PipelineCard["blocker"]["tone"];
  activity: PipelineCard["activity"]["state"];
  held: boolean;
};

type MotionCard = Pick<PipelineCard, "key" | "stage" | "blocker" | "activity" | "hold">;
type MotionSnapshot = { contextKey: string; states: ReadonlyMap<string, MotionState> };

export type PipelineMotionContext = {
  layout: "stage" | "effort";
  search: string;
  approvedOnly: boolean;
};

export function snapshotPipelineMotion(cards: readonly MotionCard[]): Map<string, MotionState> {
  return new Map(cards.map((card) => [card.key, {
    stage: card.stage,
    blockerLabel: card.blocker.label,
    blockerTone: card.blocker.tone,
    activity: card.activity.state,
    held: card.hold !== null,
  }]));
}

export function changedPipelineMotionKeys(previous: MotionSnapshot | null, current: MotionSnapshot): Set<string> {
  const changed = new Set<string>();
  if (previous === null || previous.contextKey !== current.contextKey) return changed;
  for (const [key, next] of current.states) {
    const prior = previous.states.get(key);
    if (prior && (prior.stage !== next.stage || prior.blockerLabel !== next.blockerLabel ||
      prior.blockerTone !== next.blockerTone || prior.activity !== next.activity || prior.held !== next.held)) {
      changed.add(key);
    }
  }
  return changed;
}

export function pipelineArrivalFrames(targetOpacity: number): Keyframe[] {
  return [
    { opacity: targetOpacity * 0.75, transform: "translateY(4px)" },
    { opacity: targetOpacity, transform: "none" },
  ];
}

/** Cue an existing card when its logical state changes, within this board only. */
export function usePipelineMotion(rootRef: RefObject<HTMLElement | null>, cards: readonly PipelineCard[], context: PipelineMotionContext): void {
  const previous = useRef<MotionSnapshot | null>(null);
  const running = useRef(new Map<string, Animation>());
  const contextKey = JSON.stringify([context.layout, context.search, context.approvedOnly]);

  const cancelAll = () => {
    for (const animation of running.current.values()) animation.cancel();
    running.current.clear();
  };

  useLayoutEffect(() => {
    const next = { contextKey, states: snapshotPipelineMotion(cards) };
    const prior = previous.current;
    previous.current = next;
    if (prior === null || prior.contextKey !== contextKey) {
      cancelAll();
      return;
    }
    const changed = changedPipelineMotionKeys(prior, next);
    if (changed.size === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const root = rootRef.current;
    if (root === null) return;
    for (const element of Array.from(root.querySelectorAll<HTMLElement>("[data-pipeline-motion-key]"))) {
      const key = element.dataset.pipelineMotionKey;
      if (!key || !changed.has(key)) continue;
      running.current.get(key)?.cancel();
      // Use the rendered destination opacity so held cards stay muted.
      const opacity = Number.parseFloat(window.getComputedStyle(element).opacity);
      const target = Number.isFinite(opacity) ? opacity : 1;
      const animation = element.animate(pipelineArrivalFrames(target), { duration: 220, easing: EASE_CSS });
      running.current.set(key, animation);
      const clear = () => {
        if (running.current.get(key) === animation) running.current.delete(key);
      };
      animation.onfinish = clear;
      animation.oncancel = clear;
    }
  }, [cards, contextKey, rootRef]);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => {
      if (preference.matches) cancelAll();
    };
    preference.addEventListener("change", onChange);
    return () => {
      preference.removeEventListener("change", onChange);
      cancelAll();
    };
  }, []);
}
