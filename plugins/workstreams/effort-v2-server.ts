// Effort v2 surfaces: RPC methods and CLI commands that server.ts spreads into
// its single contract and CLI. The roster read writes only its own numbering,
// and a refresh only observes; neither starts, messages, or updates a thread,
// and neither writes to GitHub.
import { PluginCliError, cliCommand } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { effortRoster, effortRosterSchema, rosterRowSchema, rosterTargets, rosterText, type EffortRoster, type RosterSources } from "./effort-roster.js";
import type { createEffortRosterStore } from "./effort-roster-store.js";
import type { EffortStore, EstablishedEffort } from "./effort-store.js";
import { canonicalPrUrl } from "./pr-holds.js";

/** Realtime: `{ effortId, prUrl }` names the one row a refresh recomputed. */
export const EFFORT_ROSTER_CHANGED = "effort-roster-changed";

export const effortV2Contract = {
  effort_roster_get: { input: z.object({ effortId: z.string().min(1).max(500) }).strict(), output: effortRosterSchema },
  effort_reconcile: { input: z.object({ effortId: z.string().min(1).max(500), prUrl: z.string().max(500) }).strict(),
    output: z.object({ status: z.enum(["checked", "failed"]), error: z.string().optional(), row: rosterRowSchema }) },
};

export type EffortV2Deps = {
  efforts: Pick<EffortStore, "get" | "getRecord" | "list">;
  numbers: ReturnType<typeof createEffortRosterStore>["numbers"];
  /** Live board facts; see RosterSources. */
  sources(): Promise<RosterSources>;
  /** Re-observe one PR's GitHub, thread, and checkout facts now. */
  observe(prUrl: string, checkouts: readonly string[]): Promise<{ status: "checked" } | { status: "failed"; error: string }>;
  realtime: { publish(channel: string, payload: unknown): void };
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
  const handlers = {
    effort_roster_get: ({ effortId }: { effortId: string }) => roster(effortId),
    effort_reconcile: ({ effortId, prUrl }: { effortId: string; prUrl: string }) => reconcile(effortId, prUrl),
  };
  const commands = {
    roster: cliCommand({
      summary: "List an effort's PRs as a numbered roster",
      positionals: [{ name: "effort", description: "Effort id, key, or exact name", required: true, variadic: true }],
      options: { json: { type: "boolean", description: "Emit the roster as JSON" } },
      async run({ positionals, options }) {
        const text = positionals.effort.join(" ").trim();
        const named = deps.efforts.list().filter((effort) => effort.name.toLocaleLowerCase() === text.toLocaleLowerCase());
        if (!deps.efforts.get(text) && named.length !== 1) {
          throw new PluginCliError(named.length > 1 ? `More than one effort is named "${text}".` : `No saved effort matches "${text}".`,
            { code: "unknown_effort", hint: "Use the effort id or key from the Efforts view." });
        }
        const current = await roster(deps.efforts.get(text) ? text : named[0]!.id);
        return { exitCode: 0, stdout: options.json ? JSON.stringify(current) : rosterText(current) };
      },
    }),
  };
  return { handlers, commands };
}
