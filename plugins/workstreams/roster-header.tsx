// The optional Roster button in an effort parent thread's header (plan
// amendment A12.4). BB mounts a header action once per visible thread, so the
// button reads which threads are parents from one store that a single app
// overlay keeps current, rather than asking the server from every header.
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useBbNavigate, useRealtime, useRpc, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Icon } from "./components/ui/icon";
import { cn } from "./lib/utils";
import { rosterPanelOpen, rosterParents, setRosterParents, subscribeRosterParents, type RosterParent } from "./roster-parents";
import { ROSTER_CHANGED } from "./roster-shared";

/** The button itself: nothing in a thread that isn't an effort parent, an icon alone on a compact viewport. */
export function RosterHeaderControl({ parent, compact, onOpen }: { parent: RosterParent | null; compact: boolean; onOpen(): void }) {
  if (!parent) return null;
  const label = `Open the ${parent.name} roster`;
  return <button type="button" onClick={onOpen} aria-label={label} title={label}
    className={cn("flex h-7 items-center gap-1.5 rounded-md text-[12px] text-muted-foreground outline-none hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
      compact ? "w-7 justify-center" : "px-2")}>
    <Icon name="ListView" className="size-4 shrink-0" aria-hidden />{compact ? null : "Roster"}
  </button>;
}

export function RosterHeaderButton({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  const parent = useSyncExternalStore(subscribeRosterParents, () => rosterParents().get(threadId) ?? null, () => null);
  return <RosterHeaderControl parent={parent} compact={isCompactViewport} onOpen={() => {
    const open = rosterPanelOpen(threadId, rosterParents());
    if (open) navigate.openThreadPanel({ actionId: "effort-roster", ...open });
  }} />;
}

/**
 * The one reader behind every header: effort_roster_list on mount, then again at most every 3 seconds after a roster or the board
 * changes (opting in, renaming, and archiving signal one of them). Renders nothing.
 */
export function RosterParentsFeed() {
  const rpc = useRpc<typeof rpcContract>();
  const load = useCallback(() => { rpc.call("effort_roster_list", null).then(setRosterParents, () => {}); }, [rpc]);
  useEffect(load, [load]);
  const timer = useRef<number | null>(null);
  const soon = useCallback(() => {
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => { timer.current = null; load(); }, 3_000);
  }, [load]);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  useRealtime(ROSTER_CHANGED, soon);
  useRealtime("board-changed", soon);
  return null;
}
