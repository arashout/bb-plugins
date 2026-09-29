// The Linear seed on the server (plan amendment A16), against a FAKE Linear:
// global fetch is stubbed, so no test here reaches the network. Tickets,
// projects, and people are fictional Inkwell ones.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pr } from "./contract.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import plugin from "./server.js";

const HOST = "host-inkwell";
const KEY = "lin_api_inkwellfakekey";
const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const pr = (number: number, title: string, branch = `reader/change${number}`): Pr => parsePrList(JSON.stringify([{ number, url: url(number), state: "OPEN", title,
  isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: branch, baseRefName: "main",
  headRefOid: "a".repeat(40), latestReviews: [], reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }], createdAt: "2026-09-21T15:00:00Z" }]))!.pr;

type Issue = { project?: { id: string; name: string; description?: string; targetDate?: string; initiatives?: string[] }; assignee?: string; state?: string };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

/** Your open PRs, a fake Linear workspace that owns team ABC and answers for `issues`, and one refresh. */
async function setup(authored: Pr[], issues: Record<string, Issue>) {
  const queries: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    expect(init.headers.authorization).toBe(KEY);
    const query = (JSON.parse(init.body) as { query: string }).query;
    queries.push(query);
    if (query.includes("viewer")) return { ok: true, status: 200, json: async () => ({ data: { viewer: { organization: { name: "Inkwell", urlKey: "inkwell" } },
      teams: { nodes: [{ key: "ABC", name: "Reader app" }] } } }) };
    const data: Record<string, unknown> = {};
    for (const match of query.matchAll(/(t\d+): issue\(id: "([^"]+)"\)/gu)) {
      const issue = issues[match[2]!];
      data[match[1]!] = issue ? { identifier: match[2], title: `Title of ${match[2]}`, state: { name: issue.state ?? "In Progress", type: "started" },
        assignee: issue.assignee ? { name: issue.assignee, displayName: issue.assignee.toLowerCase() } : null,
        project: issue.project ? { id: issue.project.id, name: issue.project.name, description: issue.project.description ?? null,
          targetDate: issue.project.targetDate ?? null, initiatives: { nodes: (issue.project.initiatives ?? []).map((name) => ({ id: `init-${name}`, name })) } } : null } : null;
    }
    return { ok: true, status: 200, json: async () => ({ data }) };
  });
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p", linearApiKeys: KEY }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: { list: async () => [] as never, getPluginMetadata: async () => ({}) as never, events: { list: async () => [] } },
  }, experimental_callHostRpc: async ({ method }) => {
    if (method === "scan" || method === "inspectPaths") return { units: [], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: authored.map((entry) => ({ repo: "inkwell/folio", pr: entry })), discoveryComplete: true,
      repositories: [{ repo: "inkwell/folio", complete: true }], complete: true, warnings: [] };
    throw new Error(`Unexpected host method ${method}`);
  } });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const call = (method: string, input: unknown) => harness.callRpc(method as never, input as never) as Promise<any>;
  const asked = () => queries.filter((query) => query.includes("issue(")).flatMap((query) => [...query.matchAll(/issue\(id: "([^"]+)"\)/gu)].map((match) => match[1]));
  return { bb, harness, call, asked, efforts: createEffortStore(bb.storage.database()) };
}

describe("Linear sync for your open PRs", () => {
  // The scan used to ask only about tickets in local checkouts, so a PR you opened from elsewhere never got its Linear project.
  it("reads Linear for tickets that appear only on your open PRs, and never sends one whose prefix no workspace owns", async () => {
    const env = await setup([pr(313, "ABC-350 Footer year"), pr(314, "Fix utf-8 names", "reader/abc-351-names")],
      { "ABC-350": { project: { id: "proj-footer", name: "Footer refresh" }, assignee: "Dana" }, "ABC-351": {} });
    expect(env.asked().sort()).toEqual(["ABC-350", "ABC-351"]);
    const stored = env.bb.storage.database().prepare("SELECT ticket, detail FROM linear_detail ORDER BY ticket").all() as { ticket: string; detail: string }[];
    expect(stored.map((row) => row.ticket)).toEqual(["ABC-350", "ABC-351"]);
    expect(JSON.parse(stored[0]!.detail)).toMatchObject({ project: { id: "proj-footer", name: "Footer refresh" }, assignee: "dana" });
  });
});
