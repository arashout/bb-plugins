import type { EffortStore, EstablishedEffort } from "./effort-store.js";
import { prTarget } from "./ghactions.js";

type Parent = { id: string; title: string | null; status: string; canSpawnChild: boolean; archivedAt: number | null; deletedAt: number | null };
export async function effortParent(store: EffortStore, effort: EstablishedEffort, prUrl: string, get: (id: string) => Promise<Parent>): Promise<{ thread: Parent; role: "pr" | "followup" } | null> {
  const repo = prTarget(prUrl)?.slug;
  const controller = repo ? store.repoController(effort.id, repo) : null;
  if (!controller?.threadId || controller.state !== "ready") return null;
  try {
    const thread = await get(controller.threadId);
    return thread.archivedAt === null && thread.deletedAt === null && thread.canSpawnChild ? { thread, role: "pr" } : null;
  } catch { return null; }
}

/** A parent-child relationship is not a filesystem lock. Refuse live writers even outside Workstreams. */
export async function activeCheckoutThread(path: string, hostId: string, list: (offset: number) => Promise<readonly { id: string; status: string; environmentPath: string | null; environmentHostId?: string | null }[]>): Promise<string | null> {
  const normalize = (value: string) => value.replace(/\/+$/u, "");
  for (let offset = 0; offset < 10_000; offset += 100) {
    const rows = await list(offset);
    const active = rows.find((thread) => (thread.environmentHostId == null || thread.environmentHostId === hostId) && thread.environmentPath !== null && normalize(thread.environmentPath) === normalize(path) && !["idle", "error"].includes(thread.status));
    if (active) return active.id;
    if (rows.length < 100) return null;
  }
  throw new Error("Too many threads to verify checkout ownership. Stop competing work and try again.");
}
