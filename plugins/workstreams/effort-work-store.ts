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
import { z } from "zod";
import { instructionScopeSchema, type InstructionScope } from "./effort-command.js";
import type { Phase } from "./effort-phase.js";
import { RECIPE_IDS } from "./effort-recipes.js";
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
/** One PR's current row: decide()'s step, the facts it read, and the retry epoch its attempts count in. */
export const workRowBodySchema = z.object({
  n: z.number().int().positive().nullable(),
  cause: z.string(), detail: z.string(), userState: z.enum(USER_STATES),
  /** `plan only`: the step is planned, and nothing performs it until the reconciler runs. */
  modifiers: z.array(z.enum(["draining", "recovering", "plan only"])),
  nextAction: z.union([z.array(z.enum(RECIPE_IDS)), z.enum(["observe", "attach", "parse-report", "recover-launch", "retry-turn"])]).nullable(),
  owner: z.object({ kind: z.enum(["v2-attempt", "legacy-job", "thread", "user", "github", "reviewer", "ci", "pr"]), ref: z.string().nullable() }).strict().nullable(),
  wake: z.object({ event: z.string(), ref: z.string().nullable(), dueAt: z.number() }).strict().nullable(),
  decision: z.object({ key: z.string(), kind: z.string(), subkind: z.enum(["mark-ready", "request-review"]).nullable(), question: z.string(),
    options: z.array(optionSchema), answer: z.enum(["command", "open-thread"]) }).strict().nullable(),
  recovery: z.array(z.string()), offers: z.array(z.literal("stop")),
  retryEpoch: z.number().int().nonnegative(),
  observedHead: z.string().nullable(), observedAt: z.number().nullable(),
  gates: z.record(z.enum(GATE_IDS), z.boolean().nullable()).nullable(),
  tickets: z.array(z.object({ id: z.string(), title: z.string().nullable(), url: z.string().nullable() }).strict()),
}).strict();
export type WorkRowBody = z.infer<typeof workRowBodySchema>;
export type WorkRow = { target: string; effortId: string; instructionId: string; phase: Phase; revision: number; dueAt: number | null; body: WorkRowBody };
/** A row write at the revision it was decided from; 0 for a PR with no row yet. */
export type RowWrite = { target: string; expectedRevision: number; phase: Phase; body: WorkRowBody; dueAt: number | null };

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
const instructionId = (effortId: string, revision: number) => `I-${effortId}-r${revision}`;

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
    rows(effortId: string): WorkRow[] {
      return (db.prepare(`SELECT ${ROW} FROM effort_pr_work WHERE effort_id = ? ORDER BY target`).all(effortId) as StoredRow[]).map(readRow);
    },
    row,
    /** The result an admitted command returned, so a repeated request gets the same answer and changes nothing. */
    command(effortId: string, requestId: string): unknown {
      const row = db.prepare(`SELECT detail FROM effort_transitions WHERE effort_id = ? AND target IS NULL AND cause = 'command'
        AND json_extract(detail, '$.requestId') = ?`).get(effortId, requestId) as { detail: string } | undefined;
      return row ? (JSON.parse(row.detail) as { result: unknown }).result : null;
    },
    /**
     * One command or event: a new revision or a cancellation, the rows it changed, each row's transition,
     * and the command's journal entry, all at the revisions it read. `also` runs inside the same transaction.
     */
    commit(input: { effortId: string; baseRevision: number; source: string; rows: readonly RowWrite[];
      instruction: { scope: InstructionScope; text: string; source: CommandSource; snapshotId: string | null; requestId: string } | "cancel" | null;
      journal: { requestId: string; text: string; result: unknown } | null; also?: () => void }): void {
      db.transaction(() => {
        const at = now();
        if (lastRevision(input.effortId) !== input.baseRevision) throw new Error("The instruction changed while this command was read. Reload the roster and send it again.");
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
          if ((stored?.revision ?? 0) !== write.expectedRevision) throw new Error(`${target} changed while this command was read. Reload the roster and send it again.`);
          // A row moves to another effort only once it no longer holds its PR.
          if (stored && stored.effortId !== input.effortId && holdsPr(stored)) throw new Error(`${target} is in another effort's instruction.`);
          const body = workRowBodySchema.parse(write.body);
          const revision = write.expectedRevision + 1;
          db.prepare(`INSERT INTO effort_pr_work (target, effort_id, instruction_id, phase, revision, due_at, body, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(target) DO UPDATE SET effort_id = excluded.effort_id, instruction_id = excluded.instruction_id, phase = excluded.phase,
            revision = excluded.revision, due_at = excluded.due_at, body = excluded.body, updated_at = excluded.updated_at`)
            .run(target, input.effortId, instructionId(input.effortId, newest), write.phase, revision, write.dueAt, JSON.stringify(body), at);
          db.prepare(`INSERT INTO effort_transitions (effort_id, target, row_revision, at, from_phase, to_phase, cause, detail, source, observed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.effortId, target, revision, at, stored?.phase ?? null, write.phase, body.cause, body.detail, input.source, body.observedAt);
        }
        if (input.journal) db.prepare(`INSERT INTO effort_transitions (effort_id, at, cause, detail, source) VALUES (?, ?, 'command', ?, ?)`)
          .run(input.effortId, at, JSON.stringify(input.journal), input.source);
        input.also?.();
      })();
    },
  };
}
