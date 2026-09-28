// Which threads are effort parents, for every thread header at once. One app
// overlay reads effort_roster_list and writes it here; each mounted header
// only reads, so opening many threads costs no RPC per header (plan
// amendment A12.4). Imports nothing, so the browser bundle can use it.

/** One effort_roster_list entry. */
export type RosterListEntry = { id: string; key: string; name: string; archived: boolean; mode: "legacy" | "v2"; parentThreadId: string | null };
export type RosterParent = { effortId: string; name: string };

let parents: ReadonlyMap<string, RosterParent> = new Map();
const listeners = new Set<() => void>();

/** Effort parents by thread: only a v2 effort reports to a parent thread. Listeners hear only a change in who is a parent. */
export function setRosterParents(list: readonly RosterListEntry[]): void {
  const next = new Map(list.flatMap((effort) => effort.mode === "v2" && effort.parentThreadId
    ? [[effort.parentThreadId, { effortId: effort.id, name: effort.name }] as const] : []));
  const same = next.size === parents.size && [...next].every(([thread, parent]) => {
    const current = parents.get(thread);
    return current?.effortId === parent.effortId && current.name === parent.name;
  });
  if (same) return;
  parents = next;
  for (const listener of listeners) listener();
}

export function rosterParents(): ReadonlyMap<string, RosterParent> {
  return parents;
}

export function subscribeRosterParents(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** How a thread opens its Roster tab: an effort parent opens its effort's roster; any other thread gets the picker. */
export function rosterPanelOpen(threadId: string, known: ReadonlyMap<string, RosterParent>): { title: string; params: { effortId: string } } | undefined {
  const parent = known.get(threadId);
  return parent ? { title: `${parent.name} roster`, params: { effortId: parent.effortId } } : undefined;
}
