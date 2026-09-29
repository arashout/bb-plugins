import { useEffect, useState } from "react";

/**
 * Wall-clock time, re-read on an interval.
 *
 * Every other value in this plugin's surfaces changes because of a realtime
 * event; ages change because *nothing* happened, which is the one case a
 * render-time `Date.now()` cannot see. Without a tick, a brief written two hours
 * ago reads "just now" for as long as the tab is left open, and a done card that
 * went cold overnight keeps its project colour — worse than saying nothing,
 * because both are read as facts about the thread.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
