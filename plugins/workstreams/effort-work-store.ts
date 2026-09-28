// One execution authority per effort. An effort runs on legacy launchers until
// it opts into v2; from then on every PR its roster owns is fenced from legacy
// Advance, dispatch, repair, and agent runs. The owned set is kept here so each
// fence reads it synchronously, and it is rewritten with the mode in one
// transaction, so an effort is never on v2 with its PRs unfenced.
//
// A v2 effort's standing instruction is kept by revision, one active at a
// time, beside one current row per PR and an append-only journal of every row
// change and admitted command. A command's writes land in one transaction at
// the revisions it read, or not at all.
//
// A decision is recorded once per real choice: rows asking the same question
// share one open decision, numbered D1, D2, ... for good within the effort.
//
// One writer per PR, checkout, and thread is the database's to enforce: an
// attempt that is launching, running, or uncertain holds partial unique index
// entries on all three, so a second claim fails inside its transaction however
// the two launches interleave. A claim ends only by a status change here.
import { z } from "zod";
import { envelopeSchema } from "./completion-envelope.js";
import { EFFECTS, instructionScopeSchema, WORK_RECIPES, type InstructionScope } from "./effort-command.js";
import type { Attempt, Phase } from "./effort-phase.js";
import { CODE_RECIPE_IDS, RECIPE_IDS, WORKER_RECIPE_IDS, WORKER_RESULTS } from "./effort-recipes.js";
import type { CriterionEvidence } from "./outcome-evidence.js";
import { GATE_IDS } from "./pr-gates.js";
import type { RunDb } from "./runstore.js";
import { prWorkItemKey } from "./work-item-index.js";

/** Append-only: server.ts adds these after pr_facts (ids 39-41). */
export const EFFORT_EXECUTION_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS effort_execution (effort_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK (mode IN ('legacy','v2')), revision INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS effort_v2_targets (target TEXT PRIMARY KEY, effort_id TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('pr','ticket')), resolved_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS effort_v2_targets_effort ON effort_v2_targets (effort_id)`,
];

/** Append-only: server.ts adds these after the execution migrations (ids 42-46). */
export const EFFORT_INSTRUCTION_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS effort_instructions (id TEXT PRIMARY KEY, effort_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','superseded','completed','cancelled')), request_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (effort_id, revision))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS effort_instructions_active ON effort_instructions (effort_id) WHERE status = 'active'`,
  `CREATE TABLE IF NOT EXISTS effort_pr_work (target TEXT PRIMARY KEY, effort_id TEXT NOT NULL, instruction_id TEXT NOT NULL, phase TEXT NOT NULL, revision INTEGER NOT NULL, due_at INTEGER, body TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS effort_pr_work_effort ON effort_pr_work (effort_id, phase)`,
  `CREATE TABLE IF NOT EXISTS effort_transitions (seq INTEGER PRIMARY KEY AUTOINCREMENT, effort_id TEXT NOT NULL, target TEXT, row_revision INTEGER, at INTEGER NOT NULL, from_phase TEXT, to_phase TEXT, cause TEXT NOT NULL, detail TEXT NOT NULL, attempt_id TEXT, source TEXT NOT NULL, observed_at INTEGER, UNIQUE (target, row_revision))`,
];

/** Append-only: server.ts adds these after the instruction migrations (ids 47-48). */
export const EFFORT_DECISION_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS effort_decisions (id TEXT PRIMARY KEY, effort_id TEXT NOT NULL, ordinal INTEGER NOT NULL, dedupe_key TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('open','answered','withdrawn')), body TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER, UNIQUE (effort_id, ordinal))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS effort_decisions_open ON effort_decisions (effort_id, dedupe_key) WHERE status = 'open'`,
];

/** Append-only: server.ts adds these after the decision migrations (ids 49-53). */
export const EFFORT_ATTEMPT_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS effort_attempts (id TEXT PRIMARY KEY, target TEXT NOT NULL, effort_id TEXT NOT NULL, instruction_id TEXT NOT NULL, launch_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK (status IN ('launching','running','uncertain','completed','failed','released')), thread_id TEXT, host_id TEXT, checkout_path TEXT, body TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS effort_attempts_pr_writer ON effort_attempts (target) WHERE status IN ('launching','running','uncertain')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS effort_attempts_checkout_writer ON effort_attempts (host_id, checkout_path) WHERE status IN ('launching','running','uncertain') AND checkout_path IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS effort_attempts_thread_writer ON effort_attempts (thread_id) WHERE status IN ('launching','running','uncertain') AND thread_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS effort_attempts_target ON effort_attempts (target, created_at)`,
];

/** Append-only: server.ts adds this after the attempt migrations (id 54). Each row transition keeps the head its row was observed on. */
export const EFFORT_JOURNAL_MIGRATIONS = [`ALTER TABLE effort_transitions ADD COLUMN head TEXT`];

const sourceSchema = z.object({ kind: z.enum(["panel", "banner", "thread", "cli"]), threadId: z.string().nullable(), eventId: z.string().nullable() }).strict();
export type CommandSource = z.infer<typeof sourceSchema>;
/** One revision of the standing instruction: its scope, and the command and surface that produced it. */
const instructionBodySchema = instructionScopeSchema.omit({ revision: true }).extend({ text: z.string().max(4_000), source: sourceSchema, snapshotId: z.string().nullable() }).strict();
export type Instruction = { id: string; effortId: string; revision: number; status: "active" | "superseded" | "completed" | "cancelled";
  scope: InstructionScope; text: string; source: CommandSource; snapshotId: string | null };

/** The five user states, plus system issues, which the roster groups apart. */
export const USER_STATES = ["doing", "waiting", "decision", "ready", "issue", "done"] as const;
export type UserState = (typeof USER_STATES)[number];
const PHASES = ["queued", "executing", "verifying", "waiting", "paused", "decision-needed", "repair-needed", "prepared", "finished"] as const satisfies readonly Phase[];
const optionSchema = z.object({ id: z.string(), label: z.string() }).strict();
const grantsSchema = z.object({ work: z.array(z.enum(WORK_RECIPES)), effects: z.array(z.enum(EFFECTS)) }).strict().nullable();
/**
 * One code action on the PR, once per head and retry epoch. Its key is in the row before the GitHub write; `pending`
 * until GitHub answers, or until a read shows whether an unclear answer landed. `tries` counts its writes.
 */
const codeActionSchema = z.object({ recipe: z.enum(CODE_RECIPE_IDS), headOid: z.string(), retryEpoch: z.number().int().nonnegative(), key: z.string(),
  status: z.enum(["pending", "done", "write-refused", "rate-limited"]), retryAt: z.number().nullable(), tries: z.number().int().nonnegative(), at: z.number(),
  detail: z.string().max(800).nullable() }).strict();
export type StoredCodeAction = z.infer<typeof codeActionSchema>;
/** A row keeps its newest code actions, which are all decide() reads: those on the current head. */
export const CODE_ACTIONS_KEPT = 20;
/** One PR's current row: decide()'s step, the facts it read, and the retry epoch its attempts count in. */
export const workRowBodySchema = z.object({
  n: z.number().int().positive().nullable(),
  cause: z.string(), detail: z.string(), userState: z.enum(USER_STATES),
  /** `plan only`: the step is planned, and nothing performs it yet: a launch in a dry run, or a code action. */
  modifiers: z.array(z.enum(["draining", "recovering", "plan only"])),
  nextAction: z.union([z.array(z.enum(RECIPE_IDS)), z.enum(["observe", "attach", "parse-report", "recover-launch", "retry-turn"])]).nullable(),
  owner: z.object({ kind: z.enum(["v2-attempt", "legacy-job", "thread", "user", "github", "reviewer", "ci", "pr"]), ref: z.string().nullable() }).strict().nullable(),
  wake: z.object({ event: z.string(), ref: z.string().nullable(), dueAt: z.number() }).strict().nullable(),
  decision: z.object({ key: z.string(), kind: z.string(), subkind: z.enum(["mark-ready", "request-review"]).nullable(), question: z.string(),
    options: z.array(optionSchema), grants: grantsSchema, answer: z.enum(["command", "open-thread"]) }).strict().nullable(),
  recovery: z.array(z.string()), offers: z.array(z.literal("stop")),
  retryEpoch: z.number().int().nonnegative(),
  observedHead: z.string().nullable(), observedAt: z.number().nullable(),
  gates: z.record(z.enum(GATE_IDS), z.boolean().nullable()).nullable(),
  tickets: z.array(z.object({ id: z.string(), title: z.string().nullable(), url: z.string().nullable() }).strict()),
  /** Code actions, newest first; absent until the first one. */
  codeActions: z.array(codeActionSchema).max(CODE_ACTIONS_KEPT).optional(),
  /** In a dry run, the launch a queued step would make: its work, where it would run, and the key that would claim it. Nothing holds it. */
  plan: z.object({ recipes: z.array(z.enum(WORKER_RECIPE_IDS)), role: z.enum(["code", "planning"]), launchKey: z.string(),
    resource: z.object({ kind: z.string(), threadId: z.string().nullable(), path: z.string().nullable(), hostId: z.string().nullable(), reason: z.string().nullable() }).strict() })
    .strict().optional(),
}).strict();
export type WorkRowBody = z.infer<typeof workRowBodySchema>;
export type WorkRow = { target: string; effortId: string; instructionId: string; phase: Phase; revision: number; dueAt: number | null; body: WorkRowBody };
/** Whether two row bodies say the same thing, ignoring when the row next falls due. */
export const sameBody = (a: WorkRowBody, b: WorkRowBody) => comparable(a) === comparable(b);
const comparable = (body: WorkRowBody) => JSON.stringify({ ...body, wake: body.wake && { ...body.wake, dueAt: 0 } },
  (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
/** A row write at the revision it was decided from; 0 for a PR with no row yet. `attemptId` names the attempt its transition records. */
export type RowWrite = { target: string; expectedRevision: number; phase: Phase; body: WorkRowBody; dueAt: number | null; attemptId?: string };

/** Launching, running, and uncertain attempts hold their claims; the rest are history. */
export type AttemptStatus = "launching" | "running" | "uncertain" | "completed" | "failed" | "released";
const workspaceSchema = z.object({ batchId: z.string(), jobId: z.string(), sourcePath: z.string(), moveCleanToHead: z.boolean() }).strict();
/**
 * A finished turn's report as completion-envelope read it, less the feedback evidence it saved. Its `key` is null
 * until the output is read against fresh facts; the raw output is kept whatever the result.
 */
const reportSchema = z.object({
  raw: z.string(), source: z.enum(["v1", "legacy"]).nullable(), envelope: envelopeSchema.nullable(), compat: z.array(z.string()), rejection: z.string().nullable(),
  key: z.enum(WORKER_RESULTS).nullable(), headOid: z.string().nullable(), baseMoved: z.boolean(),
  criteria: z.array(z.object({ criterion: z.string(), target: z.string(), headOid: z.string(), outcome: z.enum(["passed", "failed", "not-run"]), accepted: z.boolean() }).strict()),
  blocker: z.object({ summary: z.string(), question: z.string().nullable(), options: z.array(optionSchema), prUrl: z.string().nullable() }).strict().nullable(),
}).strict();
/** One launch: the work order it bound, where it runs, and what reading BB back found. */
const attemptBodySchema = z.object({
  instructionRevision: z.number().int().positive(),
  recipes: z.array(z.enum(WORKER_RECIPE_IDS)).min(1),
  role: z.enum(["code", "planning"]),
  retryEpoch: z.number().int().nonnegative(), retryIndex: z.number().int().nonnegative(),
  start: z.object({ headOid: z.string(), baseOid: z.string(), fingerprint: z.string().nullable(), sourceIds: z.array(z.string()) }).strict(),
  resource: z.object({ kind: z.enum(["reuse", "spawn", "worktree", "same-thread"]), threadId: z.string().nullable(), path: z.string().nullable(),
    hostId: z.string().nullable(), projectId: z.string().nullable(), reason: z.string().nullable(), workspace: workspaceSchema.nullable() }).strict(),
  mode: z.enum(["spawn", "send"]),
  marker: z.string(),
  /** When the spawn or send returned or threw, or a restart found the launch unfinished. Readback counts only from here. */
  settledAt: z.number().nullable(),
  /** When the launch went uncertain, which the breaker's run of uncertain launches reads. */
  uncertainAt: z.number().nullable(),
  /**
   * The first complete readback after settling that found no worker; a second one at least a minute later releases the claim. For a work
   * order sent to a thread, the first read of the idle thread that found it neither in a turn request nor queued.
   */
  emptyReadbackAt: z.number().nullable(),
  /** Why the launch failed for good (project-source, workspace, unpushed-worktree), or what keeps an uncertain one (duplicate-writer, source-unavailable). */
  failure: z.string().nullable(),
  error: z.string().max(800).nullable(),
  releasedReason: z.enum(["no-worker", "user-cancelled", "stopped"]).nullable(),
  // What the worker's turn did, filled in as BB reports it; absent until then.
  /** The seq of the turn request that carries the marker, and of the thread's last event when the turn was read complete. */
  startSeq: z.number().int().nullable().optional(),
  endSeq: z.number().int().nullable().optional(),
  /** When the turn was read complete. */
  endedAt: z.number().nullable().optional(),
  report: reportSchema.nullable().optional(),
  /** The worker is waiting on your input in its thread. */
  interactionPending: z.boolean().optional(),
  /** Its thread was archived or deleted: a turn that hadn't finished then never will. */
  threadGone: z.boolean().optional(),
  /** A failed turn waiting for its retry: the turn request to retry, and when. */
  turnFailure: z.object({ requestId: z.string().nullable(), sendAt: z.number() }).strict().nullable().optional(),
  /** Retries v2 asked BB for; a retry core queued itself isn't one. */
  turnRetries: z.number().int().nonnegative().optional(),
  /** Readbacks in a row that couldn't read BB; one that reads clears it. */
  readbackFailures: z.number().int().nonnegative().optional(),
  /** When `stop N` asked this running worker to stop. Its claim holds until a read shows its thread no longer active. */
  stopRequestedAt: z.number().nullable().optional(),
}).strict();
export type AttemptBody = z.infer<typeof attemptBodySchema>;
export type AttemptReport = z.infer<typeof reportSchema>;
export type StoredAttempt = { id: string; target: string; effortId: string; instructionId: string; launchKey: string; status: AttemptStatus;
  threadId: string | null; hostId: string | null; path: string | null; body: AttemptBody; createdAt: number };
/** An attempt as decide() reads it. */
export function decideAttempt({ id, status, threadId, path, body }: StoredAttempt): Attempt {
  return { id, status, threadId, path, workspace: body.resource.workspace && { batchId: body.resource.workspace.batchId, jobId: body.resource.workspace.jobId },
    recipes: body.recipes, retryEpoch: body.retryEpoch, headOid: body.start.headOid, fingerprint: body.start.fingerprint,
    endedAt: status === "failed" || status === "completed" ? body.endedAt ?? body.settledAt : null,
    result: status === "completed" ? body.report?.key ?? null : null, blocker: body.report?.blocker ?? null, failure: body.failure, releasedReason: body.releasedReason,
    interactionPending: body.interactionPending ?? false, stopRequested: status === "running" && body.stopRequestedAt != null, turnFailed: Boolean(body.turnFailure),
    turnRetries: body.turnRetries ?? 0,
    readbackFailures: body.readbackFailures ?? 0 };
}
/**
 * Criteria evidence from our attempts' reports, newest first. Only an accepted report carries any, each entry bound to the head it named and to
 * the instruction revision its work order carried, since criterion ids restart with each new instruction.
 */
export const attemptEvidence = (attempts: readonly StoredAttempt[]): CriterionEvidence[] =>
  attempts.flatMap((attempt) => (attempt.body.report?.criteria ?? []).map((item) => ({ ...item, revision: attempt.body.instructionRevision })));
/**
 * One row transition as the journal keeps it, with the cause of the step it left. `source` names who wrote it: a command, a refresh, the
 * reconciler, a launch, and so on.
 */
export type JournalEntry = { seq: number; target: string; at: number; fromPhase: Phase | null; fromCause: string | null; toPhase: Phase; cause: string; source: string;
  head: string | null };
/** A write lost its compare-and-swap: the row, instruction, decision, or attempt changed after its writer read it. */
export class StaleWriteError extends Error {}
/** Another attempt holds the PR, the checkout, or the thread this claim needs, or already made this exact launch. */
export class ClaimConflictError extends Error {
  constructor(readonly holder: StoredAttempt | null) {
    super(holder ? `Attempt ${holder.id} holds this PR, checkout, or thread.` : "This launch was already made.");
  }
}
const isUnique = (error: unknown) => (error as { code?: string } | null)?.code === "SQLITE_CONSTRAINT_UNIQUE";

/**
 * One question and the PRs asking it, each at the head it asked on. `answer` is the command's reading of the answer;
 * the instruction revision it wrote holds what the answer granted and declined.
 */
const decisionBodySchema = z.object({
  kind: z.string(), subkind: z.enum(["mark-ready", "request-review"]).nullable(), question: z.string(), options: z.array(optionSchema), grants: grantsSchema,
  targets: z.array(z.object({ target: z.string(), n: z.number().int().positive().nullable(), head: z.string().nullable() }).strict()),
  answer: z.string().nullable(), answeredVia: z.enum(["panel", "banner", "thread", "cli"]).nullable(),
}).strict();
export type DecisionBody = z.infer<typeof decisionBodySchema>;
export type DecisionStatus = "open" | "answered" | "withdrawn";
export type Decision = { id: string; effortId: string; n: number; key: string; status: DecisionStatus; revision: number; body: DecisionBody };
/** A decision to write at the revision it was read at; 0 for a new one, numbered by its caller. */
export type DecisionWrite = Omit<Decision, "effortId" | "revision"> & { expectedRevision: number };

export type ExecutionMode = "legacy" | "v2";
export type Execution = { mode: ExecutionMode; revision: number };
/** A roster PR: an explicit PR member, or a PR whose ticket the effort alone owns. */
export type V2Target = { target: string; source: "pr" | "ticket" };
type WorkDb = RunDb & { transaction<T>(fn: () => T): () => T };

/**
 * A row holds its PR for its effort until it finishes, or until it pauses because another effort owns the PR or its
 * effort left v2: then the owning effort's command may take the row over. Rows pause only once their claims drain.
 */
export const holdsPr = (row: Pick<WorkRow, "phase" | "body">) => row.phase !== "finished" && !(row.phase === "paused" && ["membership-moved", "v2-off"].includes(row.body.cause));

const ROW = `target, effort_id AS effortId, instruction_id AS instructionId, phase, revision, due_at AS dueAt, body`;
type StoredRow = Omit<WorkRow, "body"> & { body: string };
const readRow = ({ body, ...row }: StoredRow): WorkRow => ({ ...row, phase: z.enum(PHASES).parse(row.phase), body: workRowBodySchema.parse(JSON.parse(body)) });
export const instructionId = (effortId: string, revision: number) => `I-${effortId}-r${revision}`;
export const decisionId = (effortId: string, n: number) => `D-${effortId}-${n}`;
const DECISION = `id, effort_id AS effortId, ordinal AS n, dedupe_key AS key, status, revision, body`;
const readDecision = ({ body, ...decision }: Omit<Decision, "body"> & { body: string }): Decision => ({ ...decision, body: decisionBodySchema.parse(JSON.parse(body)) });
const ATTEMPT = `id, target, effort_id AS effortId, instruction_id AS instructionId, launch_key AS launchKey, status, thread_id AS threadId, host_id AS hostId,
  checkout_path AS path, body, created_at AS createdAt`;
const CLAIMED = `status IN ('launching','running','uncertain')`;
type AttemptRow = Omit<StoredAttempt, "body"> & { body: string };
const readAttempt = ({ body, ...attempt }: AttemptRow): StoredAttempt => ({ ...attempt, body: attemptBodySchema.parse(JSON.parse(body)) });

export function createEffortWorkStore(db: WorkDb, now = Date.now) {
  function lastRevision(effortId: string): number {
    return (db.prepare(`SELECT MAX(revision) AS revision FROM effort_instructions WHERE effort_id = ?`).get(effortId) as { revision: number | null }).revision ?? 0;
  }
  function activeInstruction(effortId: string): Instruction | null {
    const row = db.prepare(`SELECT id, effort_id AS effortId, revision, status, body FROM effort_instructions WHERE effort_id = ? AND status = 'active'`)
      .get(effortId) as { id: string; effortId: string; revision: number; status: "active"; body: string } | undefined;
    if (!row) return null;
    const { text, source, snapshotId, ...scope } = instructionBodySchema.parse(JSON.parse(row.body));
    return { id: row.id, effortId: row.effortId, revision: row.revision, status: row.status, scope: { ...scope, revision: row.revision }, text, source, snapshotId };
  }
  function row(target: string): WorkRow | null {
    const stored = db.prepare(`SELECT ${ROW} FROM effort_pr_work WHERE target = ?`).get(prWorkItemKey(target)) as StoredRow | undefined;
    return stored ? readRow(stored) : null;
  }
  function attempt(id: string): StoredAttempt | null {
    const stored = db.prepare(`SELECT ${ATTEMPT} FROM effort_attempts WHERE id = ?`).get(id) as AttemptRow | undefined;
    return stored ? readAttempt(stored) : null;
  }
  function execution(effortId: string): Execution {
    return (db.prepare(`SELECT mode, revision FROM effort_execution WHERE effort_id = ?`).get(effortId) as Execution | undefined)
      ?? { mode: "legacy", revision: 0 };
  }
  function rewrite(targetsOf: (effortId: string) => readonly V2Target[]): void {
    db.prepare(`DELETE FROM effort_v2_targets`).run();
    const insert = db.prepare(`INSERT INTO effort_v2_targets (target, effort_id, source, resolved_at) VALUES (?, ?, ?, ?)`);
    for (const { effortId } of db.prepare(`SELECT effort_id AS effortId FROM effort_execution WHERE mode = 'v2'`).all() as { effortId: string }[])
      for (const { target, source } of targetsOf(effortId)) insert.run(prWorkItemKey(target), effortId, source, now());
  }
  return {
    execution,
    /** Change one effort's mode only at the revision its caller saw, and rewrite every v2 target with it. */
    setMode(effortId: string, mode: ExecutionMode, expectedRevision: number, targetsOf: (effortId: string) => readonly V2Target[]): Execution {
      return db.transaction(() => {
        if (execution(effortId).revision !== expectedRevision) throw new Error("The effort's execution mode changed. Refresh the preview and try again.");
        db.prepare(`INSERT INTO effort_execution (effort_id, mode, revision, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(effort_id) DO UPDATE SET mode = excluded.mode, revision = excluded.revision, updated_at = excluded.updated_at`)
          .run(effortId, mode, expectedRevision + 1, now());
        rewrite(targetsOf);
        return execution(effortId);
      })();
    },
    /** After membership or board facts change: every v2 effort's roster PRs, replaced at once. */
    rewriteTargets(targetsOf: (effortId: string) => readonly V2Target[]): void {
      db.transaction(() => rewrite(targetsOf))();
    },
    /** Whether a rewrite can change anything: some effort is on v2, or targets remain from one that left. */
    active(): boolean {
      return db.prepare(`SELECT 1 FROM effort_execution WHERE mode = 'v2' UNION ALL SELECT 1 FROM effort_v2_targets LIMIT 1`).get() !== undefined;
    },
    /** The v2 effort whose roster manages this PR, if any: a member, or a PR its instruction still holds from outside membership. */
    managedBy(prUrl: string): string | null {
      const member = db.prepare(`SELECT effort_id AS effortId FROM effort_v2_targets WHERE target = ?`).get(prWorkItemKey(prUrl)) as { effortId: string } | undefined;
      if (member) return member.effortId;
      const held = row(prUrl);
      return held && holdsPr(held) ? held.effortId : null;
    },
    /** The effort's active instruction, if any. */
    instruction: activeInstruction,
    /** The effort's newest instruction revision, active or not, or 0. */
    lastRevision,
    /** The effort's open decisions, by number. */
    decisions(effortId: string): Decision[] {
      return (db.prepare(`SELECT ${DECISION} FROM effort_decisions WHERE effort_id = ? AND status = 'open' ORDER BY ordinal`).all(effortId) as
        (Omit<Decision, "body"> & { body: string })[]).map(readDecision);
    },
    decision(id: string): Decision | null {
      const stored = db.prepare(`SELECT ${DECISION} FROM effort_decisions WHERE id = ?`).get(id) as (Omit<Decision, "body"> & { body: string }) | undefined;
      return stored ? readDecision(stored) : null;
    },
    /** The number the effort's next decision takes. Numbers are never reused, so an answer typed from an old report can't reach a newer question. */
    nextDecision(effortId: string): number {
      return ((db.prepare(`SELECT MAX(ordinal) AS n FROM effort_decisions WHERE effort_id = ?`).get(effortId) as { n: number | null }).n ?? 0) + 1;
    },
    rows(effortId: string): WorkRow[] {
      return (db.prepare(`SELECT ${ROW} FROM effort_pr_work WHERE effort_id = ? ORDER BY target`).all(effortId) as StoredRow[]).map(readRow);
    },
    /** Rows of v2 efforts that fell due, oldest first. */
    due(at: number, limit: number): WorkRow[] {
      return (db.prepare(`SELECT ${ROW} FROM effort_pr_work WHERE due_at <= ? AND phase <> 'finished'
        AND effort_id IN (SELECT effort_id FROM effort_execution WHERE mode = 'v2') ORDER BY due_at, target LIMIT ?`).all(at, limit) as StoredRow[]).map(readRow);
    },
    /** An event makes these rows due now. Their revision doesn't change: nothing about the row did. */
    markDue(targets: readonly string[], at: number): void {
      const update = db.prepare(`UPDATE effort_pr_work SET due_at = ? WHERE target = ? AND phase <> 'finished' AND (due_at IS NULL OR due_at > ?)`);
      for (const target of targets) update.run(at, prWorkItemKey(target), at);
    },
    /** A pass that found a row's step unchanged sets when it falls due again, at the revision it read. */
    reschedule(target: string, revision: number, dueAt: number | null): void {
      db.prepare(`UPDATE effort_pr_work SET due_at = ? WHERE target = ? AND revision = ?`).run(dueAt, prWorkItemKey(target), revision);
    },
    /** Journal an effort-level fact the reconciler observed, such as a criterion's status changing. */
    note(effortId: string, cause: string, detail: unknown): void {
      db.prepare(`INSERT INTO effort_transitions (effort_id, at, cause, detail, source) VALUES (?, ?, ?, ?, 'reconciler')`).run(effortId, now(), cause, JSON.stringify(detail));
    },
    /** The effort's journaled facts of one kind, newest first. */
    notes(effortId: string, cause: string, limit = 1_000): unknown[] {
      return (db.prepare(`SELECT detail FROM effort_transitions WHERE effort_id = ? AND target IS NULL AND cause = ? ORDER BY seq DESC LIMIT ?`).all(effortId, cause, limit) as
        { detail: string }[]).map((row) => JSON.parse(row.detail) as unknown);
    },
    /**
     * The effort's journal after sequence `after`: its newest sequence, and each row transition since, oldest first, with the
     * head each of those rows was last observed on at or before `after` (null when unknown).
     */
    journal(effortId: string, after: number): { through: number; transitions: JournalEntry[]; headBefore: ReadonlyMap<string, string> } {
      const through = (db.prepare(`SELECT MAX(seq) AS seq FROM effort_transitions WHERE effort_id = ?`).get(effortId) as { seq: number | null }).seq ?? 0;
      // A row's revisions are consecutive, so its previous transition holds the cause it left.
      const transitions = db.prepare(`SELECT t.seq, t.target, t.at, t.from_phase AS fromPhase, p.cause AS fromCause, t.to_phase AS toPhase, t.cause, t.source, t.head
        FROM effort_transitions t LEFT JOIN effort_transitions p ON p.target = t.target AND p.row_revision = t.row_revision - 1
        WHERE t.effort_id = ? AND t.seq > ? AND t.target IS NOT NULL ORDER BY t.seq`).all(effortId, after) as JournalEntry[];
      const before = db.prepare(`SELECT head FROM effort_transitions WHERE target = ? AND seq <= ? AND head IS NOT NULL ORDER BY seq DESC LIMIT 1`);
      const headBefore = new Map<string, string>();
      for (const target of new Set(transitions.map((item) => item.target))) {
        const head = (before.get(target, after) as { head: string } | undefined)?.head;
        if (head) headBefore.set(target, head);
      }
      return { through, transitions, headBefore };
    },
    /** When a row entered the step it is in now: the first of its newest transitions that all end in this phase and cause; null when it isn't in it. */
    entered(target: string, phase: Phase, cause: string): number | null {
      let at: number | null = null;
      for (const row of db.prepare(`SELECT at, to_phase AS phase, cause FROM effort_transitions WHERE target = ? ORDER BY seq DESC LIMIT 100`).all(prWorkItemKey(target)) as
        { at: number; phase: string; cause: string }[]) {
        if (row.phase !== phase || row.cause !== cause) break;
        at = row.at;
      }
      return at;
    },
    /** When each of the effort's open decisions was first asked, by id. */
    asked(effortId: string): Map<string, number> {
      return new Map((db.prepare(`SELECT id, created_at AS createdAt FROM effort_decisions WHERE effort_id = ? AND status = 'open'`).all(effortId) as
        { id: string; createdAt: number }[]).map((row) => [row.id, row.createdAt]));
    },
    /** Every included PR finished with its criteria held on its final head: the instruction is complete, and stays so. */
    completeInstruction(id: string): void {
      db.prepare(`UPDATE effort_instructions SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'active'`).run(now(), id);
    },
    row,
    /** Our attempts on a PR, newest first. */
    attempts(target: string): StoredAttempt[] {
      return (db.prepare(`SELECT ${ATTEMPT} FROM effort_attempts WHERE target = ? ORDER BY created_at DESC, rowid DESC`).all(prWorkItemKey(target)) as
        AttemptRow[]).map(readAttempt);
    },
    attempt,
    /** Every claim that is launching, running, or uncertain, oldest first; only one effort's when named. */
    claims(effortId?: string): StoredAttempt[] {
      return (db.prepare(`SELECT ${ATTEMPT} FROM effort_attempts WHERE ${CLAIMED} AND (? IS NULL OR effort_id = ?) ORDER BY created_at, rowid`)
        .all(effortId ?? null, effortId ?? null) as AttemptRow[]).map(readAttempt);
    },
    /** The claim on this PR or checkout, if any. Every legacy writer reads it before starting, as v2 reads theirs before claiming. */
    claimOn(prUrl: string | null, path: string | null): StoredAttempt | null {
      const stored = db.prepare(`SELECT ${ATTEMPT} FROM effort_attempts WHERE ${CLAIMED} AND (target = ? OR checkout_path = ?) LIMIT 1`)
        .get(prUrl === null ? null : prWorkItemKey(prUrl), path) as AttemptRow | undefined;
      return stored ? readAttempt(stored) : null;
    },
    /** The newest launches across every effort, newest first. */
    launches(limit: number): StoredAttempt[] {
      return (db.prepare(`SELECT ${ATTEMPT} FROM effort_attempts ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(limit) as
        AttemptRow[]).map(readAttempt);
    },
    /**
     * Claim the PR, its checkout, and its thread for a new launching attempt. Call it inside commit's `also`, so a claim
     * someone else holds rolls back the row write with it.
     */
    claim(attempt: Omit<StoredAttempt, "createdAt" | "status">): void {
      const at = now();
      try {
        db.prepare(`INSERT INTO effort_attempts (id, target, effort_id, instruction_id, launch_key, status, thread_id, host_id, checkout_path, body, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'launching', ?, ?, ?, ?, ?, ?)`).run(attempt.id, prWorkItemKey(attempt.target), attempt.effortId, attempt.instructionId, attempt.launchKey,
          attempt.threadId, attempt.hostId, attempt.path, JSON.stringify(attemptBodySchema.parse(attempt.body)), at, at);
      } catch (error) {
        if (!isUnique(error)) throw error;
        const holder = db.prepare(`SELECT ${ATTEMPT} FROM effort_attempts WHERE (${CLAIMED} AND (target = ? OR (host_id = ? AND checkout_path = ?) OR thread_id = ?))
          OR launch_key = ? ORDER BY created_at LIMIT 1`).get(prWorkItemKey(attempt.target), attempt.hostId, attempt.path, attempt.threadId, attempt.launchKey) as
          AttemptRow | undefined;
        throw new ClaimConflictError(holder ? readAttempt(holder) : null);
      }
    },
    /**
     * Move an attempt on, but only from a status its writer read; null when it moved on first. `body` patches the attempt as it is now,
     * so a fact another writer recorded while this one awaited BB or GitHub is kept. Naming a thread claims it, so a thread another
     * attempt holds is a conflict, never a second writer.
     */
    recordAttempt(id: string, from: readonly AttemptStatus[], next: { status: AttemptStatus; threadId?: string | null; path?: string | null; body: Partial<AttemptBody> }):
      StoredAttempt | null {
      const current = attempt(id);
      if (!current || !from.includes(current.status)) return null;
      try {
        db.prepare(`UPDATE effort_attempts SET status = ?, thread_id = ?, checkout_path = ?, body = ?, updated_at = ? WHERE id = ? AND status = ?`)
          .run(next.status, next.threadId === undefined ? current.threadId : next.threadId, next.path === undefined ? current.path : next.path,
            JSON.stringify(attemptBodySchema.parse({ ...current.body, ...next.body })), now(), id, current.status);
      } catch (error) {
        if (!isUnique(error)) throw error;
        const holder = db.prepare(`SELECT ${ATTEMPT} FROM effort_attempts WHERE ${CLAIMED} AND id <> ? AND (thread_id = ? OR (host_id = ? AND checkout_path = ?)) LIMIT 1`)
          .get(id, next.threadId ?? null, current.hostId, next.path ?? null) as AttemptRow | undefined;
        throw new ClaimConflictError(holder ? readAttempt(holder) : null);
      }
      return (db.prepare(`SELECT changes() AS count`).get() as { count: number }).count === 1 ? attempt(id) : null;
    },
    /**
     * `reset N release`: drop the launching or uncertain claim on a PR, which you confirmed no worker holds. Call it inside
     * the command's commit, so the release and the command that asked for it are journaled together.
     */
    release(target: string): void {
      const current = db.prepare(`SELECT ${ATTEMPT} FROM effort_attempts WHERE target = ? AND status IN ('launching','uncertain')`).get(prWorkItemKey(target)) as
        AttemptRow | undefined;
      if (!current) throw new StaleWriteError(`${target}'s launch claim changed while this command was read. Reload the roster and send it again.`);
      const { body } = readAttempt(current);
      db.prepare(`UPDATE effort_attempts SET status = 'released', body = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify({ ...body, releasedReason: "no-worker" }), now(), current.id);
    },
    /**
     * `stop N`: ask our running worker on a PR to stop. Call it inside the command's commit, so the request is journaled with the command;
     * the runner then stops the thread and releases the claim once it reads the thread no longer active.
     */
    requestStop(target: string): void {
      const current = db.prepare(`SELECT ${ATTEMPT} FROM effort_attempts WHERE target = ? AND status = 'running'`).get(prWorkItemKey(target)) as AttemptRow | undefined;
      if (!current) throw new StaleWriteError(`${target}'s worker is no longer running. Reload the roster and send it again.`);
      const { body } = readAttempt(current);
      db.prepare(`UPDATE effort_attempts SET body = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify({ ...body, stopRequestedAt: now() }), now(), current.id);
    },
    /** The result an admitted command returned, so a repeated request gets the same answer and changes nothing. */
    command(effortId: string, requestId: string): unknown {
      const row = db.prepare(`SELECT detail FROM effort_transitions WHERE effort_id = ? AND target IS NULL AND cause = 'command'
        AND json_extract(detail, '$.requestId') = ?`).get(effortId, requestId) as { detail: string } | undefined;
      return row ? (JSON.parse(row.detail) as { result: unknown }).result : null;
    },
    /** The effort's newest admitted command: its request, text, the surface it came from, when, the snapshot it read, and its result. */
    lastCommand(effortId: string): { at: number; requestId: string; text: string; origin: CommandSource["kind"] | null; snapshotId: string | null; result: unknown } | null {
      const row = db.prepare(`SELECT at, detail FROM effort_transitions WHERE effort_id = ? AND target IS NULL AND cause = 'command' ORDER BY seq DESC LIMIT 1`)
        .get(effortId) as { at: number; detail: string } | undefined;
      if (!row) return null;
      // A command journaled before its origin and snapshot were kept reads as from an unknown surface.
      const { requestId, text, result, origin = null, snapshotId = null } = JSON.parse(row.detail) as
        { requestId: string; text: string; result: unknown; origin?: CommandSource["kind"]; snapshotId?: string | null };
      return { at: row.at, requestId, text, origin, snapshotId, result };
    },
    /**
     * One command or event: a new revision or a cancellation, the rows it changed, each row's transition,
     * and the command's journal entry, all at the revisions it read. `also` runs inside the same transaction.
     */
    commit(input: { effortId: string; baseRevision: number; source: string; rows: readonly RowWrite[];
      instruction: { scope: InstructionScope; text: string; source: CommandSource; snapshotId: string | null; requestId: string } | "cancel" | null;
      decisions?: readonly DecisionWrite[];
      journal: { requestId: string; text: string; result: unknown; origin: CommandSource["kind"]; snapshotId: string | null } | null; also?: () => void }): void {
      db.transaction(() => {
        const at = now();
        if (lastRevision(input.effortId) !== input.baseRevision) throw new StaleWriteError("The instruction changed while this command was read. Reload the roster and send it again.");
        const current = activeInstruction(input.effortId);
        if (input.instruction !== null) {
          if (current) db.prepare(`UPDATE effort_instructions SET status = ?, updated_at = ? WHERE id = ?`)
            .run(input.instruction === "cancel" ? "cancelled" : "superseded", at, current.id);
          else if (input.instruction === "cancel") throw new Error("No instruction is active, so there is nothing to cancel.");
        }
        if (input.instruction !== null && input.instruction !== "cancel") {
          const { scope: { revision, ...scope }, text, source, snapshotId, requestId } = input.instruction;
          if (revision !== input.baseRevision + 1) throw new Error(`Instruction r${revision} doesn't follow r${input.baseRevision}.`);
          db.prepare(`INSERT INTO effort_instructions (id, effort_id, revision, status, request_id, body, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`)
            .run(instructionId(input.effortId, revision), input.effortId, revision, requestId,
              JSON.stringify(instructionBodySchema.parse({ ...scope, text, source, snapshotId })), at, at);
        }
        const newest = lastRevision(input.effortId);
        if (input.rows.length > 0 && newest === 0) throw new Error("Rows belong to an instruction, and this effort has none.");
        for (const write of input.rows) {
          const target = prWorkItemKey(write.target);
          const stored = row(target);
          if ((stored?.revision ?? 0) !== write.expectedRevision) throw new StaleWriteError(`${target} changed while this command was read. Reload the roster and send it again.`);
          // A row moves to another effort only once it no longer holds its PR.
          if (stored && stored.effortId !== input.effortId && holdsPr(stored)) throw new Error(`${target} is in another effort's instruction.`);
          const body = workRowBodySchema.parse(write.body);
          const revision = write.expectedRevision + 1;
          db.prepare(`INSERT INTO effort_pr_work (target, effort_id, instruction_id, phase, revision, due_at, body, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(target) DO UPDATE SET effort_id = excluded.effort_id, instruction_id = excluded.instruction_id, phase = excluded.phase,
            revision = excluded.revision, due_at = excluded.due_at, body = excluded.body, updated_at = excluded.updated_at`)
            .run(target, input.effortId, instructionId(input.effortId, newest), write.phase, revision, write.dueAt, JSON.stringify(body), at);
          db.prepare(`INSERT INTO effort_transitions (effort_id, target, row_revision, at, from_phase, to_phase, cause, detail, attempt_id, source, observed_at, head)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.effortId, target, revision, at, stored?.phase ?? null, write.phase, body.cause, body.detail,
            write.attemptId ?? null, input.source, body.observedAt, body.observedHead);
        }
        for (const write of input.decisions ?? []) {
          const body = JSON.stringify(decisionBodySchema.parse(write.body));
          const resolved = write.status === "open" ? null : at;
          if (write.expectedRevision === 0) db.prepare(`INSERT INTO effort_decisions (id, effort_id, ordinal, dedupe_key, status, body, revision, created_at, resolved_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(write.id, input.effortId, write.n, write.key, write.status, body, at, resolved);
          else {
            // Only an open decision changes, and only at the revision its writer read.
            db.prepare(`UPDATE effort_decisions SET status = ?, body = ?, revision = revision + 1, resolved_at = ? WHERE id = ? AND effort_id = ? AND revision = ? AND status = 'open'`)
              .run(write.status, body, resolved, write.id, input.effortId, write.expectedRevision);
            if ((db.prepare(`SELECT changes() AS count`).get() as { count: number }).count !== 1)
              throw new StaleWriteError(`D${write.n} changed while this command was read. Reload the roster and send it again.`);
          }
        }
        if (input.journal) db.prepare(`INSERT INTO effort_transitions (effort_id, at, cause, detail, source) VALUES (?, ?, 'command', ?, ?)`)
          .run(input.effortId, at, JSON.stringify(input.journal), input.source);
        input.also?.();
      })();
    },
  };
}
