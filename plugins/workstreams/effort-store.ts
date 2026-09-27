import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RunDb } from "./runstore.js";
import { canonicalPrUrl } from "./pr-holds.js";

export const effortMembersSchema = z.object({ tickets: z.array(z.string().min(1).max(300)).max(1000), prUrls: z.array(z.string().url().max(500)).max(1000),
  checkoutPaths: z.array(z.string().min(1).max(1_000)).max(1000).optional() }).strict();
export const establishedEffortSchema = z.object({
  id: z.string(), key: z.string(), name: z.string(), goal: z.string(), projectId: z.string(),
  coordinatorThreadId: z.string().nullable(), coordinatorState: z.enum(["none", "creating", "ready", "unavailable"]),
  members: effortMembersSchema, createdAt: z.number(), updatedAt: z.number(),
});
export type EffortMembers = z.infer<typeof effortMembersSchema>;
export type EstablishedEffort = z.infer<typeof establishedEffortSchema>;
export const repoControllerSchema = z.object({ effortId: z.string(), repo: z.string(), projectId: z.string(), hostId: z.string(),
  threadId: z.string().nullable(), previousThreadIds: z.array(z.string()).max(5).default([]),
  state: z.enum(["creating", "ready", "unavailable"]), createdAt: z.number(), updatedAt: z.number() });
export type RepoController = z.infer<typeof repoControllerSchema>;
export const EFFORT_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS established_efforts (id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS effort_members (kind TEXT NOT NULL, ref TEXT NOT NULL, effort_id TEXT NOT NULL, PRIMARY KEY(kind, ref))`,
  `CREATE TABLE IF NOT EXISTS effort_workers (thread_id TEXT PRIMARY KEY, effort_id TEXT NOT NULL, pr_url TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL)`,
];
export const REPO_CONTROLLER_MIGRATION =
  `CREATE TABLE IF NOT EXISTS effort_repo_controllers (effort_id TEXT NOT NULL, repo TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(effort_id, repo))`;
type EffortDb = RunDb & { transaction<T>(fn: () => T): () => T };
export function normalizeMembers(members: EffortMembers): EffortMembers {
  const checkoutPaths = [...new Set(members.checkoutPaths ?? [])].sort();
  return { tickets: [...new Set(members.tickets)].sort(), prUrls: [...new Set(members.prUrls.map((url) => url.toLowerCase()))].sort(),
    ...(checkoutPaths.length ? { checkoutPaths } : {}) };
}
export function sameMembers(a: EffortMembers, b: EffortMembers): boolean {
  return JSON.stringify(normalizeMembers(a)) === JSON.stringify(normalizeMembers(b));
}
export function createEffortStore(db: EffortDb, now = Date.now) {
  function read(row: unknown): EstablishedEffort | null {
    if (!row) return null;
    return establishedEffortSchema.parse(JSON.parse((row as { value: string }).value));
  }
  const get = (id: string) => read(db.prepare(`SELECT value FROM established_efforts WHERE id = ?`).get(id.replace(/^effort:/u, "")));
  function write(effort: EstablishedEffort): EstablishedEffort {
    const updated = { ...effort, members: normalizeMembers(effort.members), updatedAt: now() };
    db.prepare(`UPDATE established_efforts SET value = ? WHERE id = ?`).run(JSON.stringify(updated), updated.id);
    return updated;
  }
  /** Coordinator status writes must not restore membership captured before a transfer. */
  function save(effort: EstablishedEffort): EstablishedEffort {
    return write({ ...effort, members: get(effort.id)?.members ?? effort.members });
  }
  function owner(kind: "ticket" | "prUrl" | "checkoutPath", ref: string): EstablishedEffort | null {
    if (kind !== "prUrl") {
      const row = db.prepare(`SELECT effort_id FROM effort_members WHERE kind = ? AND ref = ?`).get(kind, ref) as { effort_id: string } | undefined;
      return row ? get(row.effort_id) : null;
    }
    const canonical = canonicalPrUrl(ref) ?? ref.toLowerCase();
    const owners = new Set((db.prepare(`SELECT ref, effort_id FROM effort_members WHERE kind = 'prUrl' AND ref LIKE ?`).all(`${canonical}%`) as { ref: string; effort_id: string }[])
      .filter((item) => (canonicalPrUrl(item.ref) ?? item.ref) === canonical).map((item) => item.effort_id));
    if (owners.size > 1) throw new Error("Conflicting ownership records exist for this PR. Resolve them before moving work.");
    return owners.size ? get([...owners][0]!) : null;
  }
  return {
    get,
    sourceKey(effortId: string): string | null {
      const row = db.prepare(`SELECT source_key AS sourceKey FROM established_efforts WHERE id = ?`).get(effortId.replace(/^effort:/u, "")) as { sourceKey: string } | undefined;
      return row?.sourceKey ?? null;
    },
    repoController(effortId: string, repo: string): RepoController | null {
      const row = db.prepare(`SELECT value FROM effort_repo_controllers WHERE effort_id = ? AND repo = ?`).get(effortId, repo.toLowerCase()) as { value: string } | undefined;
      return row ? repoControllerSchema.parse(JSON.parse(row.value)) : null;
    },
    claimRepoController(input: { effortId: string; repo: string; projectId: string; hostId: string }): { record: RepoController; created: boolean } {
      return db.transaction(() => {
        const repo = input.repo.toLowerCase();
        const existing = this.repoController(input.effortId, repo);
        if (existing) {
          if (existing.projectId !== input.projectId || existing.hostId !== input.hostId) throw new Error("The repository controller belongs to a different project or host. Inspect its thread before advancing this PR.");
          return { record: existing, created: false };
        }
        if (!get(input.effortId)) throw new Error("The effort no longer exists. Refresh the preview.");
        const record: RepoController = { ...input, repo, threadId: null, previousThreadIds: [], state: "creating", createdAt: now(), updatedAt: now() };
        db.prepare(`INSERT INTO effort_repo_controllers (effort_id, repo, value) VALUES (?, ?, ?)`).run(input.effortId, repo, JSON.stringify(record));
        return { record, created: true };
      })();
    },
    saveRepoController(record: RepoController): RepoController {
      return db.transaction(() => {
        const current = this.repoController(record.effortId, record.repo);
        if (!current || current.projectId !== record.projectId || current.hostId !== record.hostId) throw new Error("The repository controller binding changed. Inspect its thread before continuing.");
        const updated = repoControllerSchema.parse({ ...record, repo: record.repo.toLowerCase(), createdAt: current.createdAt, updatedAt: now() });
        db.prepare(`UPDATE effort_repo_controllers SET value = ? WHERE effort_id = ? AND repo = ?`).run(JSON.stringify(updated), updated.effortId, updated.repo);
        return updated;
      })();
    },
    beginDeletedRepoReplacement(effortId: string, repo: string, deletedThreadId: string): { record: RepoController; created: boolean } {
      return db.transaction(() => {
        const current = this.repoController(effortId, repo);
        if (!current) throw new Error("The repository controller record changed. Refresh the preview.");
        if (current.threadId !== deletedThreadId) return { record: current, created: false };
        const record = repoControllerSchema.parse({ ...current, threadId: null, state: "creating", previousThreadIds: [...current.previousThreadIds, deletedThreadId].slice(-5), updatedAt: now() });
        db.prepare(`UPDATE effort_repo_controllers SET value = ? WHERE effort_id = ? AND repo = ?`).run(JSON.stringify(record), effortId, repo.toLowerCase());
        return { record, created: true };
      })();
    },
    list: () => (db.prepare(`SELECT value FROM established_efforts ORDER BY id`).all()).map((row) => read(row)!),
    source: (sourceKey: string) => get(sourceKey) ?? read(db.prepare(`SELECT value FROM established_efforts WHERE source_key = ?`).get(sourceKey)),
    owner,
    /** Release only the exact coordinator claim whose workspace BB rejected before thread creation. */
    resetRejectedCoordinator(record: EstablishedEffort): boolean {
      return db.transaction(() => {
        const current = get(record.id);
        if (!current || current.coordinatorState !== "creating" || current.coordinatorThreadId !== null ||
          JSON.stringify(current) !== JSON.stringify(establishedEffortSchema.parse(record))) return false;
        save({ ...current, coordinatorState: "none" });
        return true;
      })();
    },
    /** Restore the prior binding, or discard an exact new claim, after BB rejects its workspace. */
    resetRejectedRepoController(record: RepoController, previous: RepoController | null): boolean {
      return db.transaction(() => {
        const row = db.prepare(`SELECT value FROM effort_repo_controllers WHERE effort_id = ? AND repo = ?`)
          .get(record.effortId, record.repo) as { value: string } | undefined;
        if (!row || row.value !== JSON.stringify(record) || record.state !== "creating" || record.threadId !== null) return false;
        if (previous) {
          if (previous.effortId !== record.effortId || previous.repo !== record.repo) return false;
          db.prepare(`UPDATE effort_repo_controllers SET value = ? WHERE effort_id = ? AND repo = ? AND value = ?`)
            .run(JSON.stringify(previous), record.effortId, record.repo, row.value);
        } else {
          db.prepare(`DELETE FROM effort_repo_controllers WHERE effort_id = ? AND repo = ? AND value = ?`)
            .run(record.effortId, record.repo, row.value);
        }
        return true;
      })();
    },
    establish(input: { sourceKey: string; name: string; goal: string; projectId: string; members: EffortMembers; coordinatorState?: "none" | "creating" }): EstablishedEffort {
      return db.transaction(() => {
        const existing = get(input.sourceKey) ?? read(db.prepare(`SELECT value FROM established_efforts WHERE source_key = ?`).get(input.sourceKey));
        if (existing) return existing;
        const members = normalizeMembers(input.members);
        for (const [kind, refs] of [["ticket", members.tickets], ["prUrl", members.prUrls], ["checkoutPath", members.checkoutPaths ?? []]] as const) {
          for (const ref of refs) if (db.prepare(`SELECT effort_id FROM effort_members WHERE kind = ? AND ref = ?`).get(kind, ref)) {
            throw new Error("Some work already belongs to an established effort. Refresh before coordinating.");
          }
        }
        const id = randomUUID();
        const effort: EstablishedEffort = { id, key: `effort:${id}`, name: input.name, goal: input.goal, projectId: input.projectId,
          members, coordinatorThreadId: null, coordinatorState: input.coordinatorState ?? "creating", createdAt: now(), updatedAt: now() };
        db.prepare(`INSERT INTO established_efforts (id, source_key, value) VALUES (?, ?, ?)`).run(id, input.sourceKey, JSON.stringify(effort));
        for (const [kind, refs] of [["ticket", members.tickets], ["prUrl", members.prUrls], ["checkoutPath", members.checkoutPaths ?? []]] as const) {
          for (const ref of refs) db.prepare(`INSERT INTO effort_members (kind, ref, effort_id) VALUES (?, ?, ?)`).run(kind, ref, id);
        }
        return effort;
      })();
    },
    /** Transfer ownership and both JSON member lists in one SQLite transaction. Historical workers stay with their original effort. */
    transfer(destinationKey: string, members: EffortMembers, promotion?: { name: string; members: EffortMembers }): EstablishedEffort {
      return db.transaction(() => {
        let destination = get(destinationKey);
        if (!destination && promotion) {
          const initial = normalizeMembers(promotion.members);
          const ownedPrs = new Set((db.prepare(`SELECT ref FROM effort_members WHERE kind = 'prUrl'`).all() as { ref: string }[])
            .map((row) => canonicalPrUrl(row.ref) ?? row.ref.toLowerCase()));
          for (const [kind, refs] of [["ticket", initial.tickets], ["prUrl", initial.prUrls], ["checkoutPath", initial.checkoutPaths ?? []]] as const) for (const ref of refs) {
            if (kind === "prUrl" ? ownedPrs.has(canonicalPrUrl(ref) ?? ref.toLowerCase()) : owner(kind, ref))
              throw new Error("Destination membership changed. Refresh before moving work.");
          }
          const id = randomUUID();
          destination = { id, key: `effort:${id}`, name: promotion.name, goal: "", projectId: "",
            coordinatorThreadId: null, coordinatorState: "none", members: initial, createdAt: now(), updatedAt: now() };
          db.prepare(`INSERT INTO established_efforts (id, source_key, value) VALUES (?, ?, ?)`).run(id, destinationKey, JSON.stringify(destination));
          for (const [kind, refs] of [["ticket", initial.tickets], ["prUrl", initial.prUrls], ["checkoutPath", initial.checkoutPaths ?? []]] as const) for (const ref of refs) {
            db.prepare(`INSERT INTO effort_members (kind, ref, effort_id) VALUES (?, ?, ?)`).run(kind, ref, id);
          }
        }
        if (!destination) throw new Error("The destination effort changed. Refresh before moving work.");
        const moving = normalizeMembers(members);
        const canonicalMovingPrs = new Set(moving.prUrls.map((url) => canonicalPrUrl(url) ?? url));
        const aliases = (db.prepare(`SELECT ref, effort_id FROM effort_members WHERE kind = 'prUrl'`).all() as { ref: string; effort_id: string }[])
          .filter((row) => canonicalMovingPrs.has(canonicalPrUrl(row.ref) ?? row.ref));
        const owners = new Map<string, EstablishedEffort>();
        for (const [kind, refs] of [["ticket", moving.tickets], ["prUrl", moving.prUrls], ["checkoutPath", moving.checkoutPaths ?? []]] as const) for (const ref of refs) {
          const previous = owner(kind, ref);
          if (previous && previous.id !== destination.id) owners.set(previous.id, previous);
        }
        for (const previous of owners.values()) write({ ...previous, members: {
          tickets: previous.members.tickets.filter((ref) => !moving.tickets.includes(ref)),
          prUrls: previous.members.prUrls.filter((ref) => !canonicalMovingPrs.has(canonicalPrUrl(ref) ?? ref)),
          checkoutPaths: previous.members.checkoutPaths?.filter((ref) => !moving.checkoutPaths?.includes(ref)),
        } });
        for (const alias of aliases) if (!moving.prUrls.includes(alias.ref)) {
          db.prepare(`DELETE FROM effort_members WHERE kind = 'prUrl' AND ref = ?`).run(alias.ref);
        }
        for (const [kind, refs] of [["ticket", moving.tickets], ["prUrl", moving.prUrls], ["checkoutPath", moving.checkoutPaths ?? []]] as const) for (const ref of refs) {
          db.prepare(`INSERT INTO effort_members (kind, ref, effort_id) VALUES (?, ?, ?) ON CONFLICT(kind, ref) DO UPDATE SET effort_id = excluded.effort_id`).run(kind, ref, destination.id);
        }
        return write({ ...destination, members: {
          tickets: [...destination.members.tickets, ...moving.tickets],
          prUrls: [...destination.members.prUrls.filter((ref) => !canonicalMovingPrs.has(canonicalPrUrl(ref) ?? ref)), ...moving.prUrls],
          checkoutPaths: [...(destination.members.checkoutPaths ?? []), ...(moving.checkoutPaths ?? [])],
        } });
      })();
    },
    /** Claim one connected PR cohort only if no member belongs to another effort. */
    claimUnowned(destinationKey: string, members: EffortMembers, guard: EffortMembers = members): { effort: EstablishedEffort; claimed: EffortMembers; conflict: boolean } {
      return db.transaction(() => {
        const destination = get(destinationKey);
        if (!destination) throw new Error("The destination effort changed. Refresh before assigning work.");
        const canonicalize = (value: EffortMembers) => normalizeMembers({ tickets: value.tickets,
          prUrls: value.prUrls.map((url) => canonicalPrUrl(url) ?? url.toLowerCase()) });
        const cohort = canonicalize(members);
        const checked = canonicalize({ tickets: [...cohort.tickets, ...guard.tickets], prUrls: [...cohort.prUrls, ...guard.prUrls] });
        // Older membership rows may hold copied URL variants. Compare canonical
        // identity without rewriting those rows or their effort's JSON record.
        const prOwners = new Map<string, Set<string>>();
        for (const row of db.prepare(`SELECT ref, effort_id FROM effort_members WHERE kind = 'prUrl'`).all() as { ref: string; effort_id: string }[]) {
          const key = canonicalPrUrl(row.ref) ?? row.ref.toLowerCase();
          const owners = prOwners.get(key) ?? new Set<string>();
          owners.add(row.effort_id);
          prOwners.set(key, owners);
        }
        const ownersOf = (kind: "ticket" | "prUrl" | "checkoutPath", ref: string): Set<string> => kind === "prUrl"
          ? prOwners.get(ref) ?? new Set<string>()
          : new Set((db.prepare(`SELECT effort_id FROM effort_members WHERE kind = ? AND ref = ?`).all(kind, ref) as { effort_id: string }[]).map((row) => row.effort_id));
        const claimed: EffortMembers = { tickets: [], prUrls: [] };
        for (const [kind, refs] of [["ticket", checked.tickets], ["prUrl", checked.prUrls], ["checkoutPath", guard.checkoutPaths ?? []]] as const) {
          for (const ref of refs) {
            const owners = ownersOf(kind, ref);
            if ([...owners].some((id) => id !== destination.id)) return { effort: destination,
              claimed: { tickets: [], prUrls: [] }, conflict: true };
          }
        }
        for (const [kind, refs] of [["ticket", cohort.tickets], ["prUrl", cohort.prUrls]] as const) {
          for (const ref of refs) if (ownersOf(kind, ref).size === 0) claimed[kind === "ticket" ? "tickets" : "prUrls"].push(ref);
        }
        const changed = claimed.tickets.length + claimed.prUrls.length > 0;
        const merged = changed ? effortMembersSchema.parse(normalizeMembers({
          tickets: [...destination.members.tickets, ...claimed.tickets],
          prUrls: [...destination.members.prUrls, ...claimed.prUrls],
          checkoutPaths: destination.members.checkoutPaths,
        })) : destination.members;
        for (const [kind, refs] of [["ticket", claimed.tickets], ["prUrl", claimed.prUrls]] as const) {
          for (const ref of refs) db.prepare(`INSERT INTO effort_members (kind, ref, effort_id) VALUES (?, ?, ?)`).run(kind, ref, destination.id);
        }
        return { effort: changed ? write({ ...destination, members: merged }) : destination, claimed, conflict: false };
      })();
    },
    save,
    recordWorker(effortId: string, threadId: string, prUrl: string, role: "pr" | "followup"): void {
      db.prepare(`INSERT OR REPLACE INTO effort_workers (thread_id, effort_id, pr_url, role, created_at) VALUES (?, ?, ?, ?, ?)`).run(threadId, effortId, prUrl.toLowerCase(), role, now());
    },
    workers(effortId: string, prUrl: string): { threadId: string; role: "pr" | "followup" }[] {
      return db.prepare(`SELECT thread_id AS threadId, role FROM effort_workers WHERE effort_id = ? AND pr_url = ? ORDER BY created_at DESC`).all(effortId, prUrl.toLowerCase()) as { threadId: string; role: "pr" | "followup" }[];
    },
  };
}
export type EffortStore = ReturnType<typeof createEffortStore>;
