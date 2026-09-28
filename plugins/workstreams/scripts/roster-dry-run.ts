// Read-only roster dry run over a COPY of the Workstreams database:
//   npx vite-node scripts/roster-dry-run.ts -- --db <copy> [--effort <id>|all] [--threads <dir>] [--out <file>]
//   npx vite-node scripts/roster-dry-run.ts -- --db <copy> --print-thread-ids
//   npx vite-node scripts/roster-dry-run.ts -- --db <copy> --replay-advance [--unowned-into <effort>] [--out <file>]
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
import { formatTargets, interpretEffortCommand } from "../effort-command.js";
import { effortRoster, observedFacts, rosterTargets, type RosterSources } from "../effort-roster.js";
import { createEffortRosterStore, createPrFactsStore } from "../effort-roster-store.js";
import { USER_STATES } from "../effort-work-store.js";
import { createEffortStore, repoControllerSchema, type EstablishedEffort } from "../effort-store.js";
import { planRows, rowContract } from "../effort-v2-server.js";
import { parseModelSetting } from "../execution.js";
import { createInventoryStore } from "../inventory-store.js";
import { currentLegacyAttempts } from "../legacy-history.js";
import { createLinearSync } from "../linearsync.js";
import { createPrHoldStore } from "../pr-hold-store.js";
import { prHoldFor } from "../pr-holds.js";
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

/**
 * Thread status and checkout from exported `bb thread show --json` files, which nest them as `{ thread, environment }`, and
 * status alone from `bb thread list --json`, whose threads name only an environment id; other files are ignored.
 */
function exportedThreads(directory: string): { id: string; status: string; environmentPath: string | null }[] {
  const threads = new Map<string, { id: string; status: string; environmentPath: string | null }>();
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".json")).sort()) {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, file), "utf8"));
    for (const value of Array.isArray(parsed) ? parsed : [parsed]) {
      const shown = value as { thread?: { id?: unknown; status?: unknown }; environment?: { path?: unknown } | null } | null;
      const thread = (shown?.thread ?? shown) as { id?: unknown; status?: unknown } | null;
      if (typeof thread?.id !== "string" || typeof thread.status !== "string") continue;
      const path = shown?.environment?.path;
      threads.set(thread.id, { id: thread.id, status: thread.status, environmentPath: typeof path === "string" ? path : null });
    }
  }
  return [...threads.values()];
}

/**
 * Legacy Advance's PRs replayed as synthetic v2 instructions, in memory only: one per owning effort, with PRs no
 * effort owns included from outside membership in `into`. Each is planned and rolled up, and a single command
 * naming every PR in `into` must be clarified, because other efforts own some of them.
 */
function replayAdvance(input: { batches: ReturnType<typeof advanceBatches>; sources: RosterSources; efforts: ReturnType<typeof createEffortStore>;
  numbers: ReturnType<typeof createEffortRosterStore>["numbers"]; into: EstablishedEffort | null }) {
  const { sources, efforts } = input;
  const urls = [...new Set(input.batches.flatMap((batch) => batch.jobs.map((job) => prWorkItemKey(job.prUrl))))].sort();
  const ownerOf = (target: string) => {
    const effort = efforts.get(sources.work.ownerForPr(target)?.id ?? "");
    return effort ? { effortId: effort.id, name: effort.name } : null;
  };
  const owned = new Map<string, string[]>();
  for (const url of urls) {
    const owner = ownerOf(url)?.effortId ?? null;
    if (owner) owned.set(owner, [...owned.get(owner) ?? [], url]);
  }
  const unowned = urls.filter((url) => ownerOf(url) === null);
  if (input.into && unowned.length) owned.set(input.into.id, [...owned.get(input.into.id) ?? [], ...unowned]);
  // Plan-only decisions read no checkout, so they never consult the models; these are the settings' defaults.
  const models = { code: parseModelSetting("codex/gpt-6-sol/high"), planning: parseModelSetting("codex/gpt-6-sol/medium") };
  const command = (effort: EstablishedEffort, text: string, targets: readonly string[]) => {
    const numbered = input.numbers(effort.id, rosterTargets(effort, sources.work, targets), { assign: false }).rows;
    return interpretEffortCommand(text, { effortId: effort.id, snapshot: { id: "S-replay", effortId: effort.id, stale: false, rows: numbered },
      issued: new Map(numbered.map((row) => [row.n, row.target])), holds: sources.holds, instruction: null, lastRevision: 0, decisions: [], ownerOf,
      rows: new Map(numbered.map((row) => [row.target, { finished: observedFacts(row.target, sources).facts?.state === "MERGED", teammate: false, issue: false, stopped: false, claim: null }])) });
  };
  const instructions = [...owned].map(([effortId, targets]) => {
    const effort = efforts.get(effortId)!;
    const numbered = input.numbers(effort.id, rosterTargets(effort, sources.work, targets), { assign: false }).rows.filter((row) => targets.includes(row.target));
    const text = `move ${formatTargets(numbered)} forward`;
    const result = command(effort, text, targets);
    if (result.kind === "clarify" || !result.instruction) return { effortId, name: effort.name, text, clarified: result.kind === "clarify" ? result.message : "no instruction" };
    const scope = result.instruction;
    const planned = planRows({ effort, mode: "v2", execution: "dry-run", scope, sources, models, held: (target) => prHoldFor(target, sources.holds) !== null,
      targets: scope.include.map((grant) => ({ target: grant.target, n: grant.n, retryEpoch: 0 })) });
    const contract = rowContract(effort, scope, planned, sources.work);
    // A ticket holds only through its PRs: each included PR implementing it is Ready or merged.
    const presenceOnly = contract.criteria.filter((criterion) => criterion.source === "ticket" && criterion.status === "satisfied"
      && planned.some((row) => row.body.tickets.some((ticket) => `ticket:${ticket.id}` === criterion.id) && row.phase !== "prepared" && row.body.cause !== "merged")).map((criterion) => criterion.id);
    return { effortId, name: effort.name, text, clarified: null, acknowledgment: result.acknowledgment, rollup: contract.rollup, outcomeValidated: contract.outcomeValidated, presenceOnly,
      outside: scope.include.filter((grant) => grant.outsideMembership).length, criteria: contract.criteria,
      rows: planned.map((row) => ({ n: row.body.n, target: row.target, phase: row.phase, cause: row.body.cause, detail: row.body.detail, userState: row.body.userState })) };
  });
  const crossEffort = input.into ? command(input.into, `move ${urls.join(", ")} forward`, unowned) : null;
  const legacyLatest: Record<string, number> = {};
  for (const attempt of sources.legacy.values()) if (urls.includes(prWorkItemKey(attempt.job.prUrl))) legacyLatest[attempt.job.status] = (legacyLatest[attempt.job.status] ?? 0) + 1;
  return { jobs: input.batches.reduce((sum, batch) => sum + batch.jobs.length, 0), batches: input.batches.length, prs: urls.length, unowned: unowned.length,
    crossEffort: crossEffort && { kind: crossEffort.kind, message: crossEffort.kind === "clarify" ? crossEffort.message : crossEffort.acknowledgment.join("\n") },
    instructions, legacyLatest };
}

export async function dryRun(argv: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args: argv[0] === "--" ? argv.slice(1) : argv, strict: true, options: {
    db: { type: "string" }, effort: { type: "string", default: "all" }, threads: { type: "string" }, out: { type: "string" },
    "print-thread-ids": { type: "boolean", default: false }, "ticket-pattern": { type: "string", default: DEFAULT_TICKET_PATTERN },
    "replay-advance": { type: "boolean", default: false }, "unowned-into": { type: "string" },
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
    const prFacts = createPrFactsStore(db);
    const work = workContextIndex({ links: [], ownerOf: (kind, id) => efforts.owner(kind, id),
      remotes: [...entries.map((entry) => ({ url: entry.pr.url, stale: entry.stale, tickets: ticketsIn(`${entry.pr.title}\n${entry.pr.headRefName ?? ""}`, pattern), value: null })),
        ...prFacts.reads().map((facts) => ({ url: facts.prUrl, stale: true, tickets: ticketsIn(`${facts.title}\n${facts.headRefName}`, pattern), value: null }))],
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
      full: prFacts.get,
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
    if (values["replay-advance"]) {
      const into = values["unowned-into"] === undefined ? null : efforts.get(values["unowned-into"]);
      if (values["unowned-into"] !== undefined && !into) { io.stderr(`No saved effort matches ${values["unowned-into"]}.\n`); return 2; }
      const replay = replayAdvance({ batches: advanceBatches(db), sources, efforts, numbers, into });
      const planned = replay.instructions.flatMap((item) => item.clarified === null ? item.rows : []);
      io.stdout(`replay jobs=${replay.jobs} batches=${replay.batches} prs=${replay.prs} unowned=${replay.unowned} instructions=${replay.instructions.length} rows=${planned.length}`
        + ` crossEffortCommand=${replay.crossEffort ? replay.crossEffort.kind === "clarify" ? "clarified" : "admitted" : "not-run"}`
        + ` ticketPresenceOnly=${replay.instructions.reduce((sum, item) => sum + (item.clarified === null ? item.presenceOnly.length : 0), 0)}\n`);
      for (const item of replay.instructions) io.stdout(item.clarified === null
        ? `replay ${item.effortId} prs=${item.rows.length} outside=${item.outside} outcomeValidated=${item.outcomeValidated} ${USER_STATES.map((state) =>
          `${state}=${item.rows.filter((row) => row.userState === state).length}`).join(" ")}\n`
        : `replay ${item.effortId} clarified\n`);
      io.stdout(`legacy-latest ${Object.entries(replay.legacyLatest).sort().map(([status, count]) => `${status}=${count}`).join(" ")}\n`);
      if (values.out) {
        writeFileSync(values.out, `${JSON.stringify({ database: basename(values.db), replay }, null, 2)}\n`);
        io.stderr(`Wrote the Advance replay to ${values.out}\n`);
      }
      return 0;
    }
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
