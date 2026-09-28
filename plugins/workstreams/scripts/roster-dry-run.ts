// Read-only roster dry run over a COPY of the Workstreams database:
//   npx vite-node scripts/roster-dry-run.ts -- --db <copy> [--effort <id>|all] [--threads <dir>] [--out <file>]
//   npx vite-node scripts/roster-dry-run.ts -- --db <copy> --print-thread-ids
// The database opens read-only, so any write throws. The JSON names real PRs and
// tickets, so --out must sit outside every git worktree; stdout carries counts only.
// Facts that live only in BB or plugin storage are reported as unknown-offline.
import Database from "better-sqlite3";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createApprovalFeedbackStore } from "../approval-feedback.js";
import { advanceBatchSchema } from "../bulk-advance.js";
import { rawUnitSchema } from "../contract.js";
import { createDispatchStore } from "../dispatch.js";
import { effortRoster, type RosterSources } from "../effort-roster.js";
import { createEffortRosterStore } from "../effort-roster-store.js";
import { createEffortStore, repoControllerSchema } from "../effort-store.js";
import { createInventoryStore } from "../inventory-store.js";
import { currentLegacyAttempts } from "../legacy-history.js";
import { createLinearSync } from "../linearsync.js";
import { createPrHoldStore } from "../pr-hold-store.js";
import { createRunStore } from "../runstore.js";
import { ticketsIn } from "../threads.js";
import { ticketFinder } from "../tickets.js";
import { workContextIndex } from "../work-context.js";
import { prWorkItemKey } from "../work-item-index.js";

const DEFAULT_TICKET_PATTERN = "([A-Za-z]{2,5})-(\\d{1,6})";
type Io = { stdout(text: string): void; stderr(text: string): void };

export function openReadOnly(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true });
}

/** The git worktree holding `path` (or its nearest existing ancestor), if any. */
export function gitWorktreeOf(path: string): string | null {
  let current = resolve(path);
  while (!existsSync(current)) current = dirname(current);
  for (current = realpathSync(current); ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return current;
    if (dirname(current) === current) return null;
  }
}

/** Every thread id the database refers to: the ones to export with `bb thread show` before an offline run. */
function referencedThreadIds(db: Database.Database): string[] {
  const column = (sql: string) => (db.prepare(sql).all() as { id: string | null }[]).flatMap((row) => row.id ? [row.id] : []);
  const ids = [
    ...column(`SELECT thread_id AS id FROM thread_paths`),
    ...column(`SELECT thread_id AS id FROM thread_pr_link_ids`),
    ...column(`SELECT thread_id AS id FROM effort_workers`),
    ...(db.prepare(`SELECT value FROM effort_repo_controllers`).all() as { value: string }[]).flatMap(({ value }) => {
      const controller = repoControllerSchema.parse(JSON.parse(value));
      return [controller.threadId, ...controller.previousThreadIds].filter((id) => id !== null);
    }),
    ...createEffortStore(db).listAll().flatMap((effort) => effort.coordinatorThreadId ? [effort.coordinatorThreadId] : []),
    ...advanceBatches(db).flatMap((batch) => batch.jobs.flatMap((job) => [job.threadId, ...job.previousAttempts.map((attempt) => attempt.threadId)]))
      .filter((id) => id !== null),
  ];
  return [...new Set(ids)].sort();
}

function advanceBatches(db: Database.Database) {
  return (db.prepare(`SELECT body FROM advance_batches`).all() as { body: string }[]).map(({ body }) => advanceBatchSchema.parse(JSON.parse(body)));
}

/** Thread status and environment from exported `bb thread list/show --json` files; other files are ignored. */
function exportedThreads(directory: string): { id: string; status: string; environmentPath: string | null }[] {
  const threads = new Map<string, { id: string; status: string; environmentPath: string | null }>();
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".json")).sort()) {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, file), "utf8"));
    for (const value of Array.isArray(parsed) ? parsed : [parsed]) {
      const thread = value as { id?: unknown; status?: unknown; environmentPath?: unknown; environment?: { path?: unknown } | null };
      if (typeof thread?.id !== "string" || typeof thread.status !== "string") continue;
      const path = thread.environmentPath ?? thread.environment?.path;
      threads.set(thread.id, { id: thread.id, status: thread.status, environmentPath: typeof path === "string" ? path : null });
    }
  }
  return [...threads.values()];
}

export async function dryRun(argv: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args: argv[0] === "--" ? argv.slice(1) : argv, strict: true, options: {
    db: { type: "string" }, effort: { type: "string", default: "all" }, threads: { type: "string" }, out: { type: "string" },
    "print-thread-ids": { type: "boolean", default: false }, "ticket-pattern": { type: "string", default: DEFAULT_TICKET_PATTERN },
  } });
  if (!values.db) { io.stderr("--db <copy of data.db> is required.\n"); return 2; }
  const worktree = values.out ? gitWorktreeOf(values.out) : null;
  if (worktree) { io.stderr(`Refusing --out inside the git worktree ${worktree}: the roster JSON names real PRs and tickets.\n`); return 2; }
  const db = openReadOnly(values.db);
  try {
    const threadIds = referencedThreadIds(db);
    if (values["print-thread-ids"]) { io.stdout(threadIds.map((id) => `${id}\n`).join("")); return 0; }
    const pattern = new RegExp(values["ticket-pattern"]);
    const efforts = createEffortStore(db);
    const inventory = createInventoryStore(db);
    const units = (db.prepare(`SELECT unit FROM units`).all() as { unit: string }[]).flatMap(({ unit }) => {
      const parsed = rawUnitSchema.safeParse(JSON.parse(unit));
      return parsed.success ? [parsed.data] : [];
    });
    const linkbacks = new Map((db.prepare(`SELECT url, ticket FROM pr_linkbacks WHERE ticket IS NOT NULL`).all() as { url: string; ticket: string }[])
      .map((row) => [row.url, row.ticket]));
    // Ticket prefixes learned from Linear live in plugin storage, not data.db.
    const find = ticketFinder(pattern, units, { linkbacks });
    const entries = inventory.read().entries;
    const work = workContextIndex({ links: [], ownerOf: (kind, id) => efforts.owner(kind, id),
      remotes: entries.map((entry) => ({ url: entry.pr.url, stale: entry.stale, tickets: ticketsIn(`${entry.pr.title}\n${entry.pr.headRefName ?? ""}`, pattern), value: null })),
      locals: units.flatMap((unit) => {
        const ticket = find(unit)?.ticket;
        return unit.pr ? [{ url: unit.pr.url, path: unit.path, value: null,
          tickets: [...ticketsIn(`${unit.pr.title}\n${unit.pr.headRefName ?? ""}`, pattern), ...(ticket ? [ticket] : [])] }] : [];
      }) });
    const scanned = new Map(units.flatMap((unit) => unit.pr ? [[prWorkItemKey(unit.pr.url), unit.pr] as const] : []));
    const threads = values.threads ? exportedThreads(values.threads) : null;
    const linear = createLinearSync({ db, fetch: () => Promise.reject(new Error("offline")), log: { info: () => {}, warn: () => {} } });
    const feedback = createApprovalFeedbackStore(db);
    const sources: RosterSources = {
      now: Date.now(), work,
      facts: (prUrl) => inventory.get(prUrl)?.pr ?? scanned.get(prUrl) ?? null,
      observation: (prUrl) => inventory.observation(prUrl),
      feedback: (prUrl) => feedback.get(prUrl),
      holds: createPrHoldStore(db).list(),
      legacy: currentLegacyAttempts(advanceBatches(db)),
      runs: createRunStore(db).recent(Number.MAX_SAFE_INTEGER),
      dispatch: createDispatchStore(db).attempts(),
      threads,
      tickets: (ids) => new Map([...linear.read(ids)].map(([id, detail]) => [id, { title: detail.title, url: detail.url }])),
      groups: null,
    };
    const exported = new Set(threads?.map((thread) => thread.id));
    const unknownOffline = [
      { field: "suggestions", reason: "Derived groups come from the live board and plugin settings." },
      { field: "thread-metadata-links", reason: "Plugin metadata prUrl and linkedPrUrl are read from BB at runtime." },
      { field: "linear-teams", reason: "Ticket prefixes learned from Linear live in plugin storage, not data.db." },
      ...threads === null ? [{ field: "thread-status", reason: "No --threads export; rows with checkouts may have an active writer." }]
        : [{ field: "thread-status", reason: "Referenced threads without an exported show file.", count: threadIds.filter((id) => !exported.has(id)).length }],
    ];
    const numbers = createEffortRosterStore(db, efforts).numbers;
    const selected = values.effort === "all" ? efforts.list() : [efforts.get(values.effort)].filter((effort) => effort !== null);
    if (selected.length === 0) { io.stderr(`No saved effort matches ${values.effort}.\n`); return 2; }
    const rosters = selected.map((effort) => {
      const roster = effortRoster({ effort, redirectedFrom: null, sources, number: (targets) => numbers(effort.id, targets, { assign: false }) });
      const open = roster.rows.filter((row) => row.state !== "done");
      const counts = { prs: open.length, done: roster.rows.length - open.length,
        tickets: new Set([...roster.rows.flatMap((row) => row.tickets.map((ticket) => ticket.id)), ...roster.ticketsWithoutPrs.map((ticket) => ticket.id)]).size,
        checkouts: new Set(open.flatMap((row) => row.checkouts)).size, ticketsWithoutPrs: roster.ticketsWithoutPrs.length,
        doing: open.filter((row) => row.state === "doing").length, issues: open.filter((row) => row.state === "issue").length,
        legacyJobs: roster.history.legacyJobs, legacyPrs: roster.history.legacyPrs };
      io.stdout(`${effort.id}${effort.archivedAt ? " (archived)" : ""} ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(" ")}\n`);
      return { ...roster, counts, rows: roster.rows.map((row) => threads === null && row.checkouts.length > 0 ? { ...row, threadStatus: "unknown-offline" } : row) };
    });
    if (values.out) {
      writeFileSync(values.out, `${JSON.stringify({ database: basename(values.db), ticketPattern: pattern.source, unknownOffline, rosters }, null, 2)}\n`);
      io.stderr(`Wrote ${rosters.length} rosters to ${values.out}\n`);
    }
    return 0;
  } finally {
    db.close();
  }
}

// vite-node drops the script path from argv, so only the test runner's flag tells an import from a run.
if (!process.env.VITEST) {
  process.exitCode = await dryRun(process.argv.slice(2), { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) });
}
