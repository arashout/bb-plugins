// Effort v2 surfaces: RPC methods and CLI commands that server.ts spreads into
// its single contract and CLI. The roster read writes only its own numbering,
// and a refresh only observes; neither starts, messages, or updates a thread,
// and neither writes to GitHub. Opting in only links or starts the parent
// thread and fences the roster's PRs from legacy launchers; it never changes
// membership, reparents a thread, or starts work.
import { PluginCliError, cliCommand } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { AdvanceJob } from "./bulk-advance.js";
import { effortRoster, effortRosterSchema, rosterRowSchema, rosterTargets, rosterText, type EffortRoster, type RosterSources } from "./effort-roster.js";
import type { createEffortRosterStore } from "./effort-roster-store.js";
import { RECIPES } from "./effort-recipes.js";
import type { EffortStore, EstablishedEffort } from "./effort-store.js";
import type { Execution, ExecutionMode } from "./effort-work-store.js";
import { canonicalPrUrl } from "./pr-holds.js";
import { prWorkItemKey } from "./work-item-index.js";

/** Realtime: `{ effortId, prUrl }` names the one row a refresh recomputed. */
export const EFFORT_ROSTER_CHANGED = "effort-roster-changed";

const executionSchema = z.object({ mode: z.enum(["legacy", "v2"]), revision: z.number().int().nonnegative() });
const legacyJobSchema = z.object({ batchId: z.string(), jobId: z.string(), prUrl: z.string(), repo: z.string(), number: z.number(),
  status: z.string(), uncertain: z.boolean() });
const parentCandidateSchema = z.object({ threadId: z.string(), title: z.string(), reason: z.enum(["coordinator", "origin", "linked"]), canSpawnChild: z.boolean() });
export type ParentCandidate = z.infer<typeof parentCandidateSchema>;
type LegacyJob = z.infer<typeof legacyJobSchema>;
export const effortV2PreviewSchema = z.object({
  effort: z.object({ id: z.string(), key: z.string(), name: z.string(), coordinatorThreadId: z.string().nullable() }),
  execution: executionSchema,
  /** Nothing executes for a v2 effort until the reconciler ships, so execution is always a dry run. */
  v2Execution: z.literal("dry-run"),
  consequence: z.string(),
  /** Why opting in is refused now; empty when it is allowed. */
  blockers: z.array(z.string()),
  /** Explicit members, and the roster PRs they resolve to, including PRs owned through tickets. */
  members: z.object({ tickets: z.number(), prUrls: z.number(), prs: z.number(), open: z.number() }),
  /** A null recommendation starts one new parent. While a coordinator launch is unresolved, the threads it started count as the coordinator. */
  parent: z.object({ candidates: z.array(parentCandidateSchema), recommended: z.string().nullable(), reason: z.string() }),
  /** Queued jobs are cancelled one by one at opt-in; started or uncertain ones drain. */
  legacy: z.object({ queued: z.array(legacyJobSchema), draining: z.array(legacyJobSchema) }),
  active: z.object({ runs: z.array(z.object({ prUrl: z.string(), action: z.string(), status: z.string() })),
    dispatch: z.array(z.object({ prUrl: z.string(), action: z.string(), status: z.string() })) }),
});
export type EffortV2Preview = z.infer<typeof effortV2PreviewSchema>;
const effortV2SetResultSchema = z.object({ execution: executionSchema, parentThreadId: z.string().nullable(),
  cancelled: z.array(legacyJobSchema), draining: z.array(legacyJobSchema) });

export const effortV2Contract = {
  effort_roster_get: { input: z.object({ effortId: z.string().min(1).max(500) }).strict(), output: effortRosterSchema },
  effort_reconcile: { input: z.object({ effortId: z.string().min(1).max(500), prUrl: z.string().max(500) }).strict(),
    output: z.object({ status: z.enum(["checked", "failed"]), error: z.string().optional(), row: rosterRowSchema }) },
  effort_v2_preview: { input: z.object({ effortId: z.string().min(1).max(500) }).strict(), output: effortV2PreviewSchema },
  /** `parentThreadId` names a preview candidate, or null to start one new parent; opting in requires one. */
  effort_v2_set: { input: z.object({ effortId: z.string().min(1).max(500), mode: z.enum(["legacy", "v2"]), expectedRevision: z.number().int().nonnegative(),
    parentThreadId: z.string().min(1).max(200).nullable().optional() }).strict(), output: effortV2SetResultSchema },
};

/** The one prompt a new parent receives: it holds rosters and decisions and takes no model turn beyond this reply. */
export const parentPrompt = (name: string) => `This is the effort parent thread for ${name}. Workstreams posts rosters and decisions here. Reply only: Ready.`;

export type EffortV2Deps = {
  efforts: Pick<EffortStore, "get" | "getRecord" | "list">;
  numbers: ReturnType<typeof createEffortRosterStore>["numbers"];
  /** Live board facts; see RosterSources. */
  sources(): Promise<RosterSources>;
  /** Re-observe one PR's GitHub, thread, and checkout facts now. */
  observe(prUrl: string, checkouts: readonly string[]): Promise<{ status: "checked" } | { status: "failed"; error: string }>;
  realtime: { publish(channel: string, payload: unknown): void };
  execution: {
    get(effortId: string): Execution;
    /** Only at the revision the caller saw; the roster's PRs are fenced or released in the same write. */
    set(effortId: string, mode: ExecutionMode, expectedRevision: number): Promise<Execution>;
  };
  parent: {
    /**
     * Existing threads that can become the parent: unarchived, idle unless already the coordinator, and on the planning provider.
     * While a coordinator launch is unresolved, any thread it started is offered as the coordinator.
     */
    candidates(effort: EstablishedEffort, targets: readonly string[]): Promise<ParentCandidate[]>;
    adopt(effortId: string, threadId: string): Promise<EstablishedEffort>;
    start(effortId: string, prompt: string): Promise<EstablishedEffort>;
  };
  legacy: {
    jobs(): readonly { batchId: string; job: Pick<AdvanceJob, "id" | "prUrl" | "repo" | "number" | "status" | "uncertain"> }[];
    /** Cancel one job that never started; false when it has moved on. */
    cancelQueued(batchId: string, jobId: string): boolean;
  };
  autoDispatches(effortId: string): boolean;
};

export function createEffortV2(deps: EffortV2Deps) {
  /** A saved effort by id or key; a merged source redirects to its destination. Derived groups are not efforts. */
  function resolve(effortId: string): { effort: EstablishedEffort; redirectedFrom: string | null } {
    const effort = deps.efforts.get(effortId);
    if (!effort) throw new Error("That effort does not exist. Choose a saved effort; derived groups are only suggestions.");
    const requested = deps.efforts.getRecord(effortId);
    return { effort, redirectedFrom: requested && requested.id !== effort.id ? requested.id : null };
  }
  async function roster(effortId: string): Promise<EffortRoster> {
    const { effort, redirectedFrom } = resolve(effortId);
    const sources = await deps.sources();
    return effortRoster({ effort, redirectedFrom, sources, number: (targets) => deps.numbers(effort.id, targets, { assign: true }) });
  }
  const observing = new Map<string, ReturnType<EffortV2Deps["observe"]>>();
  /** The Refresh escape hatch: re-observe one roster row and recompute it. Concurrent refreshes of a PR share one read. */
  async function reconcile(effortId: string, prUrl: string) {
    const { effort } = resolve(effortId);
    const target = canonicalPrUrl(prUrl);
    const { work } = await deps.sources();
    if (target === null || !rosterTargets(effort, work).includes(target)) throw new Error("That PR is not on this effort's roster.");
    let observed = observing.get(target);
    if (!observed) {
      observed = deps.observe(target, work.items.get(target)?.paths ?? []).finally(() => observing.delete(target));
      observing.set(target, observed);
    }
    const result = await observed;
    deps.realtime.publish(EFFORT_ROSTER_CHANGED, { effortId: effort.id, prUrl: target });
    const row = (await roster(effort.id)).rows.find((item) => item.target === target);
    // A full read keeps a PR placed after the board drops it, so a row leaves only when ownership moved or no read succeeded.
    if (!row) throw new Error(`That PR is no longer on this effort's roster${result.status === "failed" ? `: ${result.error}` : "."}`);
    return { ...result, row };
  }
  /** Legacy Advance jobs on these PRs: queued ones never started and are cancelled one by one; started or uncertain ones drain. */
  function legacyJobs(targets: ReadonlySet<string>): EffortV2Preview["legacy"] {
    const jobs = deps.legacy.jobs().filter(({ job }) => targets.has(prWorkItemKey(job.prUrl)))
      .map(({ batchId, job }): LegacyJob => ({ batchId, jobId: job.id, prUrl: job.prUrl, repo: job.repo, number: job.number, status: job.status, uncertain: job.uncertain }));
    return { queued: jobs.filter((job) => job.status === "queued" && !job.uncertain),
      draining: jobs.filter((job) => job.uncertain || ["launching", "running", "verifying"].includes(job.status)) };
  }
  /** The preview, and the roster PRs it read, which opting in reads legacy jobs for again once they are fenced. */
  async function inspect(effortId: string): Promise<{ preview: EffortV2Preview; targets: Set<string> }> {
    const { effort, redirectedFrom } = resolve(effortId);
    const execution = deps.execution.get(effort.id);
    const sources = await deps.sources();
    // Provisional numbers: a preview reads the roster without numbering it.
    const { rows } = effortRoster({ effort, redirectedFrom, sources, number: (targets) => deps.numbers(effort.id, targets, { assign: false }) });
    const targets = new Set(rows.map((row) => row.target));
    const candidates = await deps.parent.candidates(effort, [...targets]);
    const coordinator = candidates.find((candidate) => candidate.reason === "coordinator");
    const origin = candidates.find((candidate) => candidate.reason === "origin" && candidate.canSpawnChild);
    const blockers = execution.mode === "v2" ? [] : [
      ...(redirectedFrom ? [`This effort was merged into ${effort.name}. Opt in ${effort.name} instead.`] : []),
      ...(effort.archivedAt ? ["Restore this effort before moving it to its roster."] : []),
      ...(deps.autoDispatches(effort.id) ? ["Turn off automatic dispatch for this effort before moving it to its roster."] : []),
      // An unresolved launch never starts a second parent, so opting in waits until the thread it started can be linked.
      ...(effort.coordinatorState === "creating" && !coordinator ? ["A coordinator launch is unresolved. Inspect it before moving this effort to its roster."] : []),
    ];
    const onRoster = (prUrl: string | null) => prUrl !== null && targets.has(prWorkItemKey(prUrl));
    const summary: EffortV2Preview = {
      effort: { id: effort.id, key: effort.key, name: effort.name, coordinatorThreadId: effort.coordinatorThreadId },
      execution, v2Execution: "dry-run", blockers,
      consequence: execution.mode === "v2" ? "Legacy Advance and dispatch apply to this effort again. Every v2 record is kept."
        : "Legacy Advance and dispatch stop for this effort. v2 plans work but runs nothing until v2 execution is on.",
      members: { tickets: effort.members.tickets.length, prUrls: effort.members.prUrls.length, prs: rows.length,
        open: rows.filter((row) => row.state !== "done").length },
      parent: { candidates, recommended: (coordinator ?? origin)?.threadId ?? null,
        reason: coordinator ? "The effort's coordinator becomes its parent." : origin ? "The thread that created this effort becomes its parent."
          : "No coordinator or originating thread is available on the planning model, so one new parent starts unless you choose a linked thread." },
      legacy: legacyJobs(targets),
      active: {
        runs: sources.runs.filter((run) => onRoster(run.prUrl) && ["running", "needs-you"].includes(run.status))
          .map((run) => ({ prUrl: run.prUrl!, action: run.action, status: run.status })),
        dispatch: sources.dispatch.filter((attempt) => onRoster(attempt.prUrl) && ["launching", "running", "verifying", "needs-you"].includes(attempt.status))
          .map(({ prUrl, action, status }) => ({ prUrl, action, status })),
      },
    };
    return { preview: summary, targets };
  }
  const preview = async (effortId: string) => (await inspect(effortId)).preview;
  const changing = new Set<string>();
  /** Opt in: link or start the parent, fence the roster's PRs, then cancel each queued legacy job. Opting out keeps every record. */
  async function setMode(input: z.infer<typeof effortV2Contract.effort_v2_set.input>) {
    const { preview: current, targets } = await inspect(input.effortId);
    const effortId = current.effort.id;
    if (changing.has(effortId)) throw new Error("This effort's execution mode is already changing. Refresh the preview after it settles.");
    // The preview awaited board and thread reads, so another change may have landed since it read the revision.
    if (current.execution.revision !== input.expectedRevision || deps.execution.get(effortId).revision !== input.expectedRevision) throw new Error("The effort's execution mode changed. Refresh the preview and try again.");
    if (current.execution.mode === input.mode) throw new Error(input.mode === "v2" ? "This effort already runs on its roster." : "This effort already runs on legacy launchers.");
    changing.add(effortId);
    try {
      if (input.mode === "legacy") {
        if (input.parentThreadId !== undefined) throw new Error("Opting out keeps the parent thread. Leave the parent out.");
        const execution = await deps.execution.set(effortId, "legacy", input.expectedRevision);
        return { execution, parentThreadId: current.effort.coordinatorThreadId, cancelled: [], draining: [] };
      }
      if (current.blockers.length) throw new Error(current.blockers.join(" "));
      if (input.parentThreadId === undefined) throw new Error("Choose a parent thread from the preview, or null to start one new parent.");
      if (input.parentThreadId !== null && !current.parent.candidates.some((candidate) => candidate.threadId === input.parentThreadId))
        throw new Error("That thread can't be this effort's parent. Refresh the preview and choose one of its candidates.");
      const parent = input.parentThreadId === null ? await deps.parent.start(effortId, parentPrompt(current.effort.name))
        : await deps.parent.adopt(effortId, input.parentThreadId);
      const execution = await deps.execution.set(effortId, "v2", input.expectedRevision);
      // Read again once fenced: a queued job may have launched while the parent was linked or started, and none can launch now.
      const legacy = legacyJobs(targets);
      const cancelled = legacy.queued.filter((job) => deps.legacy.cancelQueued(job.batchId, job.jobId));
      return { execution, parentThreadId: parent.coordinatorThreadId, cancelled, draining: legacy.draining };
    } finally { changing.delete(effortId); }
  }
  const handlers = {
    effort_roster_get: ({ effortId }: { effortId: string }) => roster(effortId),
    effort_reconcile: ({ effortId, prUrl }: { effortId: string; prUrl: string }) => reconcile(effortId, prUrl),
    effort_v2_preview: ({ effortId }: { effortId: string }) => preview(effortId),
    effort_v2_set: setMode,
  };
  /** A CLI effort argument: id, key, or exact name. */
  function effortArg(words: readonly string[]): string {
    const text = words.join(" ").trim();
    if (deps.efforts.get(text)) return text;
    const named = deps.efforts.list().filter((effort) => effort.name.toLocaleLowerCase() === text.toLocaleLowerCase());
    if (named.length === 1) return named[0]!.id;
    throw new PluginCliError(named.length > 1 ? `More than one effort is named "${text}".` : `No saved effort matches "${text}".`,
      { code: "unknown_effort", hint: "Use the effort id or key from the Efforts view." });
  }
  const jobLine = (jobs: readonly LegacyJob[]) => jobs.map((job) => `${job.repo} #${job.number}${job.uncertain ? " (uncertain)" : ""}`).join(", ") || "none";
  const commands = {
    recipes: cliCommand({
      summary: "List the action recipes v2 composes into work orders",
      options: { json: { type: "boolean", description: "Emit the catalog as JSON" } },
      async run({ options }) {
        return { exitCode: 0, stdout: options.json ? JSON.stringify(RECIPES) : RECIPES.map((item) =>
          `${item.action} · ${item.executor === "worker" ? `worker on the ${item.modelRole} model` : "code"} · effects: ${item.effects.join(", ") || "none"}`).join("\n") };
      },
    }),
    roster: cliCommand({
      summary: "List an effort's PRs as a numbered roster",
      positionals: [{ name: "effort", description: "Effort id, key, or exact name", required: true, variadic: true }],
      options: { json: { type: "boolean", description: "Emit the roster as JSON" } },
      async run({ positionals, options }) {
        const current = await roster(effortArg(positionals.effort));
        return { exitCode: 0, stdout: options.json ? JSON.stringify(current) : rosterText(current) };
      },
    }),
    "v2 preview": cliCommand({
      summary: "Show what moving an effort to its v2 roster would change",
      positionals: [{ name: "effort", description: "Effort id, key, or exact name", required: true, variadic: true }],
      options: { json: { type: "boolean", description: "Emit the preview as JSON" } },
      async run({ positionals, options }) {
        const current = await preview(effortArg(positionals.effort));
        return { exitCode: 0, stdout: options.json ? JSON.stringify(current) : [
          `${current.effort.name} · ${current.execution.mode} · revision ${current.execution.revision}`,
          current.consequence,
          `PRs: ${current.members.prs} (${current.members.open} open) from ${current.members.tickets} tickets and ${current.members.prUrls} PRs`,
          `Parent: ${current.parent.recommended ?? "a new thread"}. ${current.parent.reason}`,
          `Candidates: ${current.parent.candidates.map((candidate) => `${candidate.threadId} (${candidate.reason})`).join(", ") || "none"}`,
          `Queued legacy jobs to cancel: ${jobLine(current.legacy.queued)}`,
          `Legacy jobs that drain: ${jobLine(current.legacy.draining)}`,
          ...current.blockers.map((blocker) => `Blocked: ${blocker}`),
        ].join("\n") };
      },
    }),
    "v2 set": cliCommand({
      summary: "Move an effort to its v2 roster with a parent thread, or back to legacy launchers",
      positionals: [{ name: "effort", description: "Effort id, key, or exact name", required: true, variadic: true }],
      options: {
        mode: { type: "enum", values: ["v2", "legacy"], required: true, description: "Execution mode" },
        revision: { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER, required: true, description: "The revision `v2 preview` showed" },
        parent: { type: "string", description: "A parent candidate's thread id from `v2 preview`" },
        "new-parent": { type: "boolean", description: "Start one new parent thread instead" },
        json: { type: "boolean", description: "Emit the result as JSON" },
      },
      constraints: [{ kind: "at-most-one", options: ["parent", "new-parent"] }],
      async run({ positionals, options }) {
        const parentThreadId = options["new-parent"] ? null : options.parent;
        let result: z.infer<typeof effortV2SetResultSchema>;
        try {
          result = await setMode({ effortId: effortArg(positionals.effort), mode: options.mode, expectedRevision: options.revision,
            ...(parentThreadId === undefined ? {} : { parentThreadId }) });
        } catch (error) {
          if (error instanceof PluginCliError) throw error;
          throw new PluginCliError(error instanceof Error ? error.message : String(error), { code: "v2_set_refused" });
        }
        return { exitCode: 0, stdout: options.json ? JSON.stringify(result) : [
          `${result.execution.mode === "v2" ? "Runs on its roster" : "Runs on legacy launchers"} (revision ${result.execution.revision}). Parent: ${result.parentThreadId ?? "none"}.`,
          ...(result.execution.mode === "v2" ? [`Cancelled: ${jobLine(result.cancelled)}. Draining: ${jobLine(result.draining)}.`] : []),
        ].join("\n") };
      },
    }),
  };
  return { handlers, commands };
}
