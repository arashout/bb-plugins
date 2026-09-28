// Effort v2 surfaces: RPC methods and CLI commands that server.ts spreads into
// its single contract and CLI. The roster read writes only its own numbering;
// it never starts, messages, or updates a thread and never writes to GitHub.
import { PluginCliError, cliCommand } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { effortRoster, effortRosterSchema, rosterText, type EffortRoster, type RosterSources } from "./effort-roster.js";
import type { createEffortRosterStore } from "./effort-roster-store.js";
import type { EffortStore, EstablishedEffort } from "./effort-store.js";

export const effortV2Contract = {
  effort_roster_get: { input: z.object({ effortId: z.string().min(1).max(500) }).strict(), output: effortRosterSchema },
};

export type EffortV2Deps = {
  efforts: Pick<EffortStore, "get" | "getRecord" | "list">;
  numbers: ReturnType<typeof createEffortRosterStore>["numbers"];
  /** Live board facts; see RosterSources. */
  sources(): Promise<RosterSources>;
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
  const handlers = {
    effort_roster_get: ({ effortId }: { effortId: string }) => roster(effortId),
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
