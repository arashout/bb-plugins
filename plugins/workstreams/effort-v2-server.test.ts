import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawUnit } from "./contract.js";
import type { EffortRoster, RosterRow } from "./effort-roster.js";
import type { EffortCommandResult } from "./effort-v2-server.js";
import { createEffortWorkStore } from "./effort-work-store.js";
import { cheapSignature, createPrFactsStore } from "./effort-roster-store.js";
import { RECIPES } from "./effort-recipes.js";
import { createEffortStore } from "./effort-store.js";
import { INKWELL_ADVANCE_BATCHES, INKWELL_ADVANCE_EFFORTS, INKWELL_ROSTER } from "./inkwell-fixtures.js";
import { createLinearSync } from "./linearsync.js";
import { createRunStore } from "./runstore.js";
import { dryRun, openReadOnly } from "./scripts/roster-dry-run.js";
import plugin, { type Board } from "./server.js";
import { prWorkItemKey } from "./work-item-index.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), "workstreams-roster-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

type HostCall = (method: string, input: any) => unknown;
async function setup(state: { units: RawUnit[]; inventory: typeof INKWELL_ROSTER.inventory; threads?: ReturnType<typeof makeThreadResponse>[] } = INKWELL_ROSTER,
  /** Answers a host call, or returns undefined for the default. */
  host: { call?: HostCall } = {}) {
  const threads = new Map((state.threads ?? []).map((thread) => [thread.id, thread]));
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/Users/reader/src" }, sdk: {
    system: { config: async () => ({ primaryHostId: "host-inkwell" }) as never },
    projects: { list: async () => [{ id: "project", name: "Inkwell", sources: [{ hostId: "host-inkwell", path: "/Users/reader/src" }] }] as never },
    threads: { list: async () => [...threads.values()] as never, get: async ({ threadId }: { threadId: string }) => threads.get(threadId) as never,
      getPluginMetadata: async () => ({}) as never, events: { list: async () => [] }, interactions: { list: async () => [] as never } },
  }, experimental_callHostRpc: ({ method, input }) => {
    const answer = host.call?.(method, input);
    if (answer !== undefined) return answer as never;
    if (method === "scan") return { units: state.units, warnings: [] };
    if (method === "inspectPaths") return { units: state.units.filter((unit) => (input as { paths: string[] }).paths.includes(unit.path)), warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: state.inventory, discoveryComplete: true, complete: true,
      repositories: [...new Set(state.inventory.map((entry) => entry.repo))].map((repo) => ({ repo, complete: true })), warnings: [] };
    if (method === "linkbacks") return { found: [], warnings: [] };
    // Every other host method writes (prWrite, advanceWorkspace) or reads what a roster never needs.
    throw new Error(`Unexpected host call ${method}`);
  } });
  await plugin(bb); cleanups.push(() => harness.lifecycle.dispose());
  await harness.runCli(["refresh"]);
  const db = bb.storage.database();
  const store = createEffortStore(db);
  const efforts = Object.fromEntries(INKWELL_ROSTER.efforts.map(({ name, tickets, prUrls }) => [name,
    store.establish({ sourceKey: name, name, goal: `${name} goal`, projectId: "project", coordinatorState: "none", members: { tickets, prUrls } })]));
  createLinearSync({ db, fetch: () => Promise.reject(new Error("offline")), log: { info: () => {}, warn: () => {} } })
    .store(INKWELL_ROSTER.linear.map(({ ticket, title, url }) => ({ ticket, detail: { identifier: ticket, title, url, description: null, state: null,
      project: null, parent: null, labels: [], updatedAt: null, source: "key" } })), "key");
  const roster = async (effortId: string) => await harness.callRpc("effort_roster_get", { effortId }) as EffortRoster;
  const reconcile = async (effortId: string, prUrl: string) =>
    await harness.callRpc("effort_reconcile", { effortId, prUrl }) as { status: "checked" | "failed"; error?: string; row: RosterRow };
  return { bb, harness, db, store, efforts, roster, reconcile, threads };
}
const counts = (roster: EffortRoster) => {
  const open = roster.rows.filter((row) => row.state !== "done");
  return { prs: open.length, done: roster.rows.length - open.length, checkouts: new Set(open.flatMap((row) => row.checkouts)).size,
    tickets: new Set([...roster.rows.flatMap((row) => row.tickets.map((ticket) => ticket.id)), ...roster.ticketsWithoutPrs.map((ticket) => ticket.id)]).size };
};

describe("effort roster read model", () => {
  it("serves the acceptance cohorts from explicit and ticket ownership, never from description mentions or a ticket prefix", async () => {
    const env = await setup();
    const catalog = await env.roster(env.efforts["Catalog follow-ups"]!.id);
    const shelving = await env.roster(env.efforts["Shelving entry"]!.key);
    const vault = await env.roster(env.efforts["Vault audits"]!.id);
    expect(counts(catalog)).toEqual({ prs: 31, done: 0, checkouts: 30, tickets: 21 });
    expect(counts(shelving)).toEqual({ prs: 16, done: 7, checkouts: 13, tickets: 7 });
    expect(counts(vault)).toEqual({ prs: 18, done: 0, checkouts: 10, tickets: 10 });
    // A description that mentions a Catalog ticket is a reference, not ownership.
    expect(catalog.rows.map((row) => row.target)).not.toEqual(expect.arrayContaining([INKWELL_ROSTER.described[0]]));
    expect(vault.rows.map((row) => row.target)).toEqual(expect.arrayContaining(INKWELL_ROSTER.described));
    // Vault owns ten OPS tickets, not every OPS ticket to come.
    expect([catalog, shelving, vault].flatMap((roster) => roster.rows.map((row) => row.target))).not.toContain(INKWELL_ROSTER.future);
    // Merged backend PRs are Done context: numbered, never open work.
    expect(shelving.rows.filter((row) => row.state === "done").map((row) => [row.repo, row.cause])).toEqual(Array(7).fill(["inkwell/spine", "merged"]));
    expect(catalog.rows.map((row) => row.n)).toEqual(Array.from({ length: 31 }, (_, index) => index + 1));
    expect(catalog.snapshotId).toMatch(/^S-[0-9a-f]{12}$/u);
  });

  it("links every row's tickets and lists effort tickets without a PR unnumbered", async () => {
    const env = await setup();
    const catalog = await env.roster(env.efforts["Catalog follow-ups"]!.id);
    expect(catalog.rows.find((row) => row.target === "https://github.com/inkwell/catalog/pull/96")?.tickets)
      .toEqual([{ id: "ABC-120", title: "Bookstore task 120", url: "https://linear.app/inkwell/issue/ABC-120" }]);
    expect(catalog.rows.every((row) => row.tickets.length > 0 && row.tickets.every((ticket) => ticket.title && ticket.url))).toBe(true);
    expect(catalog.ticketsWithoutPrs).toEqual([{ id: "ABC-140", title: "Bookstore task 140", url: "https://linear.app/inkwell/issue/ABC-140" }]);
    expect(catalog.ticketsWithoutPrs[0]).not.toHaveProperty("n");
  });

  it("keeps archived efforts readable and flagged, and resolves a merged source to its destination's roster", async () => {
    const env = await setup();
    const vault = env.efforts["Vault audits"]!;
    const shelving = env.efforts["Shelving entry"]!;
    env.store.setArchived(vault.id, true);
    expect((await env.roster(vault.id))).toMatchObject({ effort: { id: vault.id, archivedAt: expect.any(Number) }, rows: expect.any(Array) });
    expect((await env.roster(vault.id)).rows).toHaveLength(18);
    env.store.setArchived(vault.id, false);
    env.store.merge(vault.id, shelving.id);
    const merged = await env.roster(vault.key);
    expect(merged.effort).toMatchObject({ id: shelving.id, redirectedFrom: vault.id });
    expect(counts(merged)).toMatchObject({ prs: 34, done: 7 });
  });

  it("offers derived board groups as suggestions with their members and overlap, never as efforts", async () => {
    // A checkout whose branch names an unowned ticket, for a PR whose title names a Vault ticket:
    // Vault owns the PR, but the ticket's cluster stays a derived group.
    const pr = { ...INKWELL_ROSTER.inventory[0]!.pr, number: 901, url: "https://github.com/inkwell/folio/pull/901",
      title: "OPS-44 Audit shelf keys", headRefName: "ops-77-shelf-keys" };
    const unit: RawUnit = { ...INKWELL_ROSTER.units[0]!, path: "/Users/reader/src/folio-901", dirName: "folio-901", branch: "ops-77-shelf-keys", pr };
    const env = await setup({ units: [...INKWELL_ROSTER.units, unit], inventory: INKWELL_ROSTER.inventory });
    env.db.prepare(`INSERT INTO effort_names (member_hash, name, updated_at) VALUES ('cached-hash', 'Retired shelving name', 1)`).run();
    const vault = await env.roster(env.efforts["Vault audits"]!.id);
    expect(vault.rows.map((row) => row.target)).toContain(pr.url);
    expect(vault.suggestions).toEqual([expect.objectContaining({ tickets: ["OPS-77"], prUrls: [pr.url], overlap: [pr.url] })]);
    const derived = vault.suggestions[0]!.key;
    await expect(env.roster(derived)).rejects.toThrow("derived groups are only suggestions");
    await expect(env.roster("cached-hash")).rejects.toThrow("does not exist");
    const catalog = await env.roster(env.efforts["Catalog follow-ups"]!.id);
    expect(catalog.suggestions).toEqual([]);
  });

  it("makes a row Doing only while a writer holds it", async () => {
    const env = await setup();
    const catalogId = env.efforts["Catalog follow-ups"]!.id;
    const [first, second] = (await env.roster(catalogId)).rows;
    const runs = createRunStore(env.db);
    const finished = runs.begin({ path: first!.checkouts[0]!, ticket: "ABC-120", prUrl: first!.target, prNumber: first!.number,
      action: "investigate-ci", mode: "new", threadId: null });
    runs.settle(finished, true, "Checks are green");
    runs.begin({ path: second!.checkouts[0]!, ticket: "ABC-120", prUrl: second!.target, prNumber: second!.number,
      action: "resolve-conflicts", mode: "new", threadId: "thr_ink_writer" });
    const rows = (await env.roster(catalogId)).rows;
    expect(rows.filter((row) => row.state === "doing").map((row) => [row.n, row.owner, row.label]))
      .toEqual([[second!.n, "run", "Action running: resolve-conflicts"]]);
    expect(rows.find((row) => row.n === first!.n)).toMatchObject({ state: "not-in-instruction", cause: "review" });
  });

  it("asks for a read of a member the board read and then stopped listing, instead of calling it unobserved", async () => {
    // catalog/530 has no checkout: once it merges, the authored-PR list drops it and no board store holds it.
    const member = "https://github.com/inkwell/catalog/pull/530";
    const state = { ...INKWELL_ROSTER };
    const env = await setup(state);
    const catalog = env.efforts["Catalog follow-ups"]!.id;
    expect((await env.roster(catalog)).rows.find((row) => row.target === member)).toMatchObject({ state: "not-in-instruction", cause: "review" });
    state.inventory = INKWELL_ROSTER.inventory.filter((entry) => entry.pr.url !== member);
    await env.harness.runCli(["refresh"]);
    expect((await env.roster(catalog)).rows.find((row) => row.target === member)).toMatchObject({ state: "not-in-instruction", cause: "observe",
      label: "No longer on the board; refresh to read it", observedAt: expect.any(Number) });
  });

  it("reads without starting, messaging, or updating a thread and without a host write", async () => {
    const env = await setup();
    for (const effort of Object.values(env.efforts)) await env.roster(effort.id);
    expect(await env.harness.runCli(["roster", env.efforts["Vault audits"]!.id, "--json"])).toMatchObject({ exitCode: 0 });
    for (const path of ["threads.spawn", "threads.send", "threads.update"]) expect(env.harness.inspection.sdk.callsTo(path)).toEqual([]);
    expect(env.harness.inspection.experimental_hostRpcCalls.filter((call) => ["prWrite", "advanceWorkspace"].includes(call.method))).toEqual([]);
  });

  it("serves the recipe catalog as JSON from the CLI", async () => {
    const env = await setup();
    const result = await env.harness.runCli(["recipes", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(RECIPES);
    expect((await env.harness.runCli(["recipes"])).stdout.split("\n")[0]).toBe("integrate_base · worker on the code model · effects: code-fix, test, push");
  });

  it("prints a numbered plain roster under 1 MiB for 1,000 members", async () => {
    const title = `ABC-950 ${"Shelve a very long title ".repeat(12)}`.slice(0, 300);
    const inventory = Array.from({ length: 1_000 }, (_, index) => ({ repo: "inkwell/atlas",
      pr: { ...INKWELL_ROSTER.inventory[0]!.pr, number: 2_000 + index, url: `https://github.com/inkwell/atlas/pull/${2_000 + index}`, title,
        headRefName: `reading-list-${index}` } }));
    const env = await setup({ units: [], inventory });
    env.store.establish({ sourceKey: "reading-lists", name: "Reading lists", goal: "", projectId: "project", coordinatorState: "none",
      members: { tickets: ["ABC-950"], prUrls: [] } });
    const result = await env.harness.runCli(["roster", "reading", "lists"]);
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(1024 * 1024);
    const lines = result.stdout.split("\n");
    expect(lines).toContainEqual(expect.stringMatching(/^1 · inkwell\/atlas #2000 · — · ABC-950 Shelve a very long title/u));
    expect(lines).toContainEqual(expect.stringMatching(/^1000 · inkwell\/atlas #2999 · /u));
    expect(await env.harness.runCli(["roster", "No such effort"])).toMatchObject({ exitCode: 1 });
  });
});

describe("roster dry-run script", () => {
  async function copy() {
    const env = await setup();
    // The server numbers each roster once, as the installed plugin would have.
    const served = await Promise.all(Object.values(env.efforts).map((effort) => env.roster(effort.id)));
    const directory = temporary();
    const path = join(directory, "data.db");
    await env.db.backup(path);
    return { env, served, directory, path };
  }
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) } };
  };
  const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

  it("opens the copy read-only and matches the server's rows without changing a byte", async () => {
    const { served, directory, path } = await copy();
    expect(() => openReadOnly(path).prepare(`DELETE FROM units`).run()).toThrow(/readonly/u);
    const before = digest(path);
    const out = join(directory, "rosters.json");
    const run = io();
    expect(await dryRun(["--", "--db", path, "--out", out], run.io)).toBe(0);
    expect(digest(path)).toBe(before);
    const written = JSON.parse(readFileSync(out, "utf8")) as { rosters: (EffortRoster & { counts: Record<string, number> })[] };
    for (const roster of served) {
      const offline = written.rosters.find((item) => item.effort.id === roster.effort.id)!;
      expect(offline.rows.map((row) => [row.n, row.target, row.provisional, row.state, row.cause]))
        .toEqual(roster.rows.map((row) => [row.n, row.target, false, row.state, row.cause]));
      expect(offline.counts).toMatchObject(counts(roster));
    }
    // Stdout carries ids and counts; titles and names stay in the JSON.
    expect(run.out.join("")).not.toMatch(/Catalog|Shelv|Vault|Bookstore/u);
    expect(run.out.join("")).toMatch(/prs=31 done=0 tickets=21 checkouts=30 ticketsWithoutPrs=1/u);
  });

  it("reads a copy of the installed database, which predates roster numbers and full reads", async () => {
    const { served, directory, path } = await copy();
    const installed = new Database(path);
    installed.exec(`DROP TABLE pr_facts; DROP TABLE effort_roster_snapshots; DROP TABLE effort_roster_numbers`);
    installed.close();
    const out = join(directory, "installed.json");
    expect(await dryRun(["--db", path, "--out", out], io().io)).toBe(0);
    const written = JSON.parse(readFileSync(out, "utf8")) as { rosters: (EffortRoster & { counts: Record<string, number> })[] };
    for (const roster of served) {
      const offline = written.rosters.find((item) => item.effort.id === roster.effort.id)!;
      expect(offline.rows.every((row) => row.provisional)).toBe(true);
      expect(offline.counts).toMatchObject(counts(roster));
    }
  });

  it("replays legacy Advance's 22 PRs as one planned instruction per owning effort, each rolled up, with no ticket held by its presence alone", async () => {
    const env = await setup();
    const reader = env.store.establish({ sourceKey: "reader-accounts", name: "Reader accounts", goal: "Readers manage their own accounts", projectId: "project",
      coordinatorState: "none", members: { tickets: [], prUrls: INKWELL_ADVANCE_EFFORTS["Reader accounts"] } });
    for (const batch of INKWELL_ADVANCE_BATCHES) env.db.prepare(`INSERT INTO advance_batches (id, body) VALUES (?, ?)`).run(batch.id, JSON.stringify(batch));
    // A fresh full read finds Vault's OPS-41 PR a merge candidate: that, not the ticket's link, proves the ticket.
    const rotated = INKWELL_ADVANCE_EFFORTS["Vault audits"][0]!;
    createPrFactsStore(env.db).full(rotated, { fullAt: Date.now(), signature: null, cheapAt: null, facts: { prUrl: rotated, number: 311, title: "OPS-41 Rotate vault audit keys",
      repo: "inkwell/folio", headRefName: "ops-41-311", baseRefName: "main", headOid: "d".repeat(40), baseOid: "b".repeat(40), state: "OPEN", isDraft: false,
      isCrossRepository: false, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", needsPreparation: false, readiness: "ready", detail: "",
      unresolvedThreads: 0, threadsComplete: true, checks: "passed", basePrNumber: null, approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] } } });
    const directory = temporary();
    const path = join(directory, "data.db");
    await env.db.backup(path);
    const before = digest(path);
    const out = join(directory, "replay.json");
    const run = io();
    expect(await dryRun(["--db", path, "--replay-advance", "--unowned-into", reader.id, "--out", out], run.io)).toBe(0);
    expect(digest(path)).toBe(before);
    const stdout = run.out.join("");
    // One current row per PR, however many batches touched it; the command naming all 22 in one effort admits nothing.
    expect(stdout).toContain("replay jobs=37 batches=15 prs=22 unowned=15 instructions=3 rows=22 crossEffortCommand=clarified ticketPresenceOnly=0\n");
    expect(stdout).toContain("legacy-latest needs-attention=11 ready=2 running=2 waiting-review=7\n");
    expect(stdout).not.toMatch(/Reader|Catalog|Vault|Bookstore/u);
    const { replay } = JSON.parse(readFileSync(out, "utf8")) as { replay: { crossEffort: { kind: string; message: string };
      instructions: { name: string; outside: number; rows: { userState: string }[]; rollup: string[]; criteria: { id: string; status: string }[] }[] } };
    expect(replay.instructions.map((item) => [item.name, item.rows.length, item.outside]).sort()).toEqual([
      ["Catalog follow-ups", 1, 0], ["Reader accounts", 18, 15], ["Vault audits", 3, 0]]);
    expect(replay.crossEffort).toMatchObject({ kind: "clarify", message: expect.stringContaining("belong to other efforts") });
    for (const item of replay.instructions)
      expect(item.rollup.map((line) => line.split(":")[0])).toEqual(["Outcome", "Validated", "Still needed", "Needs a decision"]);
    // Only the Ready PR proves its ticket; the linked tickets of PRs not yet read stay unproven.
    expect(replay.instructions.flatMap((item) => item.criteria.filter((criterion) => criterion.status === "satisfied").map((criterion) => criterion.id)))
      .toEqual(["ticket:OPS-41"]);
  });

  it("refuses an --out inside a git worktree before reading anything", async () => {
    const directory = temporary();
    mkdirSync(join(directory, "repository", ".git"), { recursive: true });
    const inside = join(directory, "repository", "handoff", "rosters.json");
    const run = io();
    // The database does not exist: the refusal comes before any read.
    expect(await dryRun(["--db", join(directory, "missing.db"), "--out", inside], run.io)).toBe(2);
    expect(run.err.join("")).toContain(`Refusing --out inside the git worktree ${realpathSync(join(directory, "repository"))}`);
    expect(existsSync(join(directory, "repository", "handoff"))).toBe(false);
  });

  it("lists the thread ids to export and reads exported thread JSON, reporting what stays unknown offline", async () => {
    const { env, directory, path } = await copy();
    const ids = io();
    expect(await dryRun(["--db", path, "--print-thread-ids"], ids.io)).toBe(0);
    expect(ids.out.join("")).toBe("");
    const coordinator = { ...env.store.getRecord(env.efforts["Vault audits"]!.id)!, coordinatorThreadId: "thr_vault_parent", coordinatorState: "ready" as const };
    env.store.save(coordinator);
    const catalog = (await env.roster(env.efforts["Catalog follow-ups"]!.id)).rows[0]!;
    await env.db.backup(path);
    expect(await dryRun(["--db", path, "--print-thread-ids"], ids.io)).toBe(0);
    expect(ids.out.join("")).toBe("thr_vault_parent\n");

    const offline = join(directory, "offline.json");
    expect(await dryRun(["--db", path, "--out", offline], io().io)).toBe(0);
    const blind = JSON.parse(readFileSync(offline, "utf8"));
    expect(blind.unknownOffline.map((item: { field: string }) => item.field))
      .toEqual(["suggestions", "thread-metadata-links", "linear-teams", "thread-status"]);
    expect(blind.rosters.flatMap((roster: EffortRoster) => roster.rows).find((row: { target: string }) => row.target === catalog.target))
      .toMatchObject({ threadStatus: "unknown-offline" });

    const threads = join(directory, "threads");
    mkdirSync(threads);
    writeFileSync(join(threads, "list.json"), JSON.stringify([{ id: "thr_catalog_writer", status: "active", environmentPath: catalog.checkouts[0] }]));
    writeFileSync(join(threads, "thr_vault_parent.context.json"), JSON.stringify({ usedTokens: 1 }));
    const exported = join(directory, "exported.json");
    expect(await dryRun(["--db", path, "--threads", threads, "--out", exported], io().io)).toBe(0);
    const seen = JSON.parse(readFileSync(exported, "utf8"));
    expect(seen.unknownOffline.at(-1)).toEqual({ field: "thread-status", reason: expect.any(String), count: 1 });
    const row = seen.rosters.flatMap((roster: EffortRoster) => roster.rows).find((item: { target: string }) => item.target === catalog.target);
    expect(row).toMatchObject({ state: "doing", owner: "thread" });
    expect(row).not.toHaveProperty("threadStatus");
  });
});

describe("roster refresh", () => {
  const catalog96 = "https://github.com/inkwell/catalog/pull/96";
  const tracked = INKWELL_ROSTER.inventory.find((entry) => entry.pr.url === catalog96)!;
  const head = "c".repeat(40);
  /** GitHub after the PR was approved on a new head with green checks. */
  const approved = { ...tracked.pr, headRefOid: head, reviewDecision: "APPROVED", checkConclusions: ["SUCCESS"],
    latestReviews: [{ login: "folio-editor", state: "APPROVED" }], unresolvedReviewThreads: 0, resolvedReviewThreads: 2 };
  const full = (pr: typeof approved, patch: Record<string, unknown> = {}) => ({ ok: true, facts: { prUrl: pr.url, number: pr.number, title: pr.title,
    repo: "inkwell/catalog", headRefName: pr.headRefName!, baseRefName: "main", headOid: pr.headRefOid!, baseOid: "b".repeat(40), state: "OPEN",
    isDraft: false, isCrossRepository: false, reviewDecision: pr.reviewDecision, mergeStateStatus: "CLEAN", mergeable: "MERGEABLE",
    needsPreparation: false, readiness: "ready", detail: "", unresolvedThreads: 0, threadsComplete: true, checks: "passed", basePrNumber: null,
    approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] }, ...patch } });
  const github = (answers: { cheap?: () => unknown; full?: () => unknown }): { call: HostCall } => ({ call: (method) =>
    method === "inspectPrs" ? answers.cheap?.() : method === "advanceInspect" ? answers.full?.() : undefined });
  const approvedGithub = github({ cheap: () => ({ entries: [{ repo: tracked.repo, pr: approved }], closed: [], failed: [], warnings: [] }), full: () => full(approved) });
  const mergedGithub = github({ cheap: () => ({ entries: [], closed: [catalog96], failed: [], warnings: [] }),
    full: () => full(approved, { state: "MERGED", headOid: "", baseOid: "", readiness: "merged" }) });
  /** What the refresh finds, and what every GitHub read that begins after it sees. */
  const outcomes = {
    approved: { github: approvedGithub, row: { state: "not-in-instruction", head, checks: "passed", reviewDecision: "APPROVED", cause: "merge-candidate" },
      inventory: INKWELL_ROSTER.inventory.map((entry) => entry.pr.url === catalog96 ? { ...entry, pr: approved } : entry), boardHead: head },
    merged: { github: mergedGithub, row: { state: "done", cause: "merged" }, inventory: INKWELL_ROSTER.inventory.filter((entry) => entry.pr.url !== catalog96),
      boardHead: undefined },
  };

  it.each([["authoredPrs", "approved"], ["authoredPrs", "merged"], ["scan", "approved"], ["scan", "merged"]] as const)(
    "returns fresh facts while a full scan's %s read is in flight, and that older read never overwrites them (%s)", async (blocked, outcome) => {
      const { github: answers, row, inventory, boardHead } = outcomes[outcome];
      let release = () => {};
      let scanning = false;
      let refreshed = false;
      const env = await setup(INKWELL_ROSTER, { call: (method, input) => {
        // The blocked read began before the refresh, so it returns GitHub as it was.
        if (method === blocked && scanning && !refreshed) return new Promise((resolve) => { release = () => resolve(method === "scan" ? { units: INKWELL_ROSTER.units, warnings: [] }
          : { owners: ["inkwell"], entries: INKWELL_ROSTER.inventory, discoveryComplete: true, complete: true, repositories: [], warnings: [] }); });
        if (method === "authoredPrs" && refreshed) return { owners: ["inkwell"], entries: inventory, discoveryComplete: true, complete: true, repositories: [], warnings: [] };
        return answers.call(method, input);
      } });
      scanning = true;
      const scan = env.harness.runCli(["refresh"]);
      await vi.waitFor(() => expect(env.harness.inspection.experimental_hostRpcCalls.filter((call) => call.method === blocked)).toHaveLength(2));
      const catalog = env.efforts["Catalog follow-ups"]!.id;
      expect(await env.reconcile(catalog, catalog96)).toMatchObject({ status: "checked", row });
      refreshed = true;
      release();
      await scan;
      // The scan landed after the refresh; the roster and the board keep what the refresh read.
      expect((await env.roster(catalog)).rows.find((item) => item.target === catalog96)).toMatchObject(row);
      expect((await env.harness.callRpc("board_get", null) as Board).prInventory.entries.find((entry) => entry.pr.url === catalog96)?.pr.headRefOid).toBe(boardHead);
    });

  it("leaves the board's inventory and the roster row on the same head, checks, and review state", async () => {
    const env = await setup(INKWELL_ROSTER, approvedGithub);
    const { row } = await env.reconcile(env.efforts["Catalog follow-ups"]!.id, catalog96);
    const entry = (await env.harness.callRpc("board_get", null) as Board).prInventory.entries.find((item) => item.pr.url === catalog96)!;
    expect([row.head, row.reviewDecision, row.checks]).toEqual([entry.pr.headRefOid, entry.pr.reviewDecision, "passed"]);
    expect(entry.pr.checkConclusions).toEqual(["SUCCESS"]);
    // Only the full read proves every review thread and the stack parent, so it alone can name a merge candidate.
    expect(row).toMatchObject({ cause: "merge-candidate", gates: { "threads-resolved": true, "parent-merged": true } });
  });

  it("refreshes a teammate's PR that no board store tracks, keeping only its full facts and signature", async () => {
    const teammate = { ...approved, number: 950, url: "https://github.com/inkwell/quill/pull/950", title: "ABC-950 Reserve reading nooks",
      headRefName: "abc-950-reading-nooks" };
    const env = await setup(INKWELL_ROSTER, github({ cheap: () => ({ entries: [{ repo: "inkwell/quill", pr: teammate }], closed: [], failed: [], warnings: [] }),
      full: () => full(teammate, { repo: "inkwell/quill" }) }));
    const nooks = env.store.establish({ sourceKey: "nooks", name: "Reading nooks", goal: "", projectId: "project", coordinatorState: "none",
      members: { tickets: [], prUrls: [teammate.url] } });
    expect((await env.roster(nooks.id)).rows[0]).toMatchObject({ cause: "source-unavailable", label: "Not observed yet", head: null });
    expect((await env.reconcile(nooks.id, teammate.url)).row).toMatchObject({ head, reviewDecision: "APPROVED", cause: "merge-candidate" });
    const stored = env.db.prepare(`SELECT body, signature, full_at AS fullAt FROM pr_facts WHERE pr_url = ?`).get(teammate.url) as
      { body: string; signature: string; fullAt: number };
    expect(JSON.parse(stored.body)).toEqual(full(teammate, { repo: "inkwell/quill" }).facts);
    expect(stored.signature).toBe(cheapSignature(teammate));
    for (const table of ["authored_prs", "pr_observations"]) expect(env.db.prepare(`SELECT count(*) AS count FROM ${table} WHERE url = ?`).get(teammate.url)).toEqual({ count: 0 });
  });

  it("resolves a merged PR through the full read, where the cheap read only says it left the open list", async () => {
    const env = await setup(INKWELL_ROSTER, mergedGithub);
    const { row } = await env.reconcile(env.efforts["Catalog follow-ups"]!.id, catalog96);
    expect(row).toMatchObject({ state: "done", cause: "merged" });
    expect((await env.harness.callRpc("board_get", null) as Board).prInventory.entries.map((entry) => entry.pr.url)).not.toContain(catalog96);
  });

  it("keeps a member without a checkout numbered and linked once a refresh finds it merged, whether a ticket or the effort lists it", async () => {
    // Vault owns its described PR through the title's ticket; Catalog lists catalog/530 itself. Neither has a checkout,
    // so once GitHub says merged no board store holds either one.
    const members = [["Vault audits", INKWELL_ROSTER.described[0]!], ["Catalog follow-ups", "https://github.com/inkwell/catalog/pull/530"]] as const;
    const pulls = new Map(INKWELL_ROSTER.inventory.map(({ pr }) => [pr.url, pr]));
    const env = await setup(INKWELL_ROSTER, { call: (method, input) => {
      if (method === "inspectPrs") return { entries: [], closed: input.prUrls, failed: [], warnings: [] };
      const pr = method === "advanceInspect" ? pulls.get(input.prUrl)! : undefined;
      return pr && full({ ...approved, url: pr.url, number: pr.number, title: pr.title, headRefName: pr.headRefName }, { state: "MERGED", readiness: "merged" });
    } });
    for (const [name, url] of members) {
      const effort = env.efforts[name]!.id;
      const before = (await env.roster(effort)).rows;
      const row = before.find((item) => item.target === url)!;
      expect((await env.reconcile(effort, url)).row).toMatchObject({ n: row.n, state: "done", cause: "merged", tickets: row.tickets });
      expect((await env.roster(effort)).rows.map((item) => [item.n, item.target])).toEqual(before.map((item) => [item.n, item.target]));
    }
    // The dry run places them from a copy the same way.
    const directory = temporary();
    await env.db.backup(join(directory, "data.db"));
    const out = join(directory, "rosters.json");
    expect(await dryRun(["--db", join(directory, "data.db"), "--effort", env.efforts["Vault audits"]!.id, "--out", out], { stdout: () => {}, stderr: () => {} })).toBe(0);
    expect((JSON.parse(readFileSync(out, "utf8")) as { rosters: EffortRoster[] }).rosters[0]!.rows.find((item) => item.target === members[0][1]))
      .toMatchObject({ state: "done", cause: "merged" });
  });

  it("says why a refreshed PR left the roster instead of failing the reply's own schema", async () => {
    // The ticket-owned PR left the open list and the full read failed, so nothing places it any more.
    const described = INKWELL_ROSTER.described[0]!;
    const env = await setup(INKWELL_ROSTER, github({ cheap: () => ({ entries: [], closed: [described], failed: [], warnings: [] }),
      full: () => ({ ok: false, error: "GitHub is unavailable." }) }));
    await expect(env.reconcile(env.efforts["Vault audits"]!.id, described)).rejects.toThrow("That PR is no longer on this effort's roster: GitHub is unavailable.");
  });

  it("rejects a PR that is not on the effort's roster without reading GitHub", async () => {
    const env = await setup(INKWELL_ROSTER, approvedGithub);
    const catalog = env.efforts["Catalog follow-ups"]!.id;
    await expect(env.reconcile(catalog, INKWELL_ROSTER.future)).rejects.toThrow("not on this effort's roster");
    await expect(env.reconcile(catalog, INKWELL_ROSTER.efforts[2]!.prUrls[0]!)).rejects.toThrow("not on this effort's roster");
    expect(env.harness.inspection.experimental_hostRpcCalls.filter((call) => ["inspectPrs", "advanceInspect"].includes(call.method))).toEqual([]);
  });

  it("keeps the last successful read and records the failure", async () => {
    let down = false;
    const env = await setup(INKWELL_ROSTER, { call: (method, input) => {
      if (down && ["inspectPaths", "inspectPrs"].includes(method)) throw new Error("GitHub is unavailable");
      return approvedGithub.call(method, input);
    } });
    const catalog = env.efforts["Catalog follow-ups"]!.id;
    const first = await env.reconcile(catalog, catalog96);
    down = true;
    const second = await env.reconcile(catalog, catalog96);
    expect(second).toMatchObject({ status: "failed", error: expect.stringContaining("GitHub is unavailable"),
      row: { head, cause: "merge-candidate", failedAt: expect.any(Number) } });
    expect(second.row.observedAt).toBe(first.row.observedAt);
    expect(env.db.prepare(`SELECT error IS NOT NULL AS failed, full_at AS fullAt FROM pr_facts WHERE pr_url = ?`).get(catalog96))
      .toEqual({ failed: 1, fullAt: first.row.observedAt });
  });

  it("reads only that PR, shares one read between concurrent refreshes, and republishes only its row", async () => {
    const env = await setup(INKWELL_ROSTER, approvedGithub);
    const catalog = env.efforts["Catalog follow-ups"]!.id;
    const checkouts = (await env.roster(catalog)).rows.find((row) => row.target === catalog96)!.checkouts;
    const calls = env.harness.inspection.experimental_hostRpcCalls;
    const before = calls.length;
    await Promise.all([env.reconcile(catalog, catalog96), env.reconcile(catalog, catalog96)]);
    expect(calls.slice(before).map((call) => [call.method, call.input])).toEqual([
      ["inspectPaths", { paths: checkouts }], ["inspectPrs", { prUrls: [catalog96] }], ["advanceInspect", { prUrl: catalog96 }]]);
    expect(env.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "effort-roster-changed").map((signal) => signal.payload))
      .toEqual([{ effortId: catalog, prUrl: catalog96 }, { effortId: catalog, prUrl: catalog96 }]);
  });

  it("re-reads the threads in the row's checkout, so a missed idle event cannot leave the row Doing", async () => {
    const path = INKWELL_ROSTER.units.find((unit) => unit.pr?.url === catalog96)!.path;
    const worker = { ...makeThreadResponse({ id: "thr_catalog_worker", status: "active" }), environmentPath: path };
    const env = await setup({ ...INKWELL_ROSTER, threads: [worker] }, approvedGithub);
    const catalog = env.efforts["Catalog follow-ups"]!.id;
    expect((await env.roster(catalog)).rows.find((row) => row.target === catalog96)).toMatchObject({ state: "doing", owner: "thread" });
    env.threads.set(worker.id, { ...worker, status: "idle" });
    expect((await env.reconcile(catalog, catalog96)).row).toMatchObject({ state: "not-in-instruction", cause: "merge-candidate" });
    for (const method of ["threads.spawn", "threads.send", "threads.update"]) expect(env.harness.inspection.sdk.callsTo(method)).toEqual([]);
  });
});

describe("effort instructions", () => {
  const catalog96 = "https://github.com/inkwell/catalog/pull/96";
  const head = "c".repeat(40);
  const facts = (prUrl: string, patch: Record<string, unknown> = {}) => {
    const pr = INKWELL_ROSTER.inventory.find((entry) => entry.pr.url === prUrl)!.pr;
    return { ok: true, facts: { prUrl, number: pr.number, title: pr.title, repo: prUrl.split("/").slice(3, 5).join("/"), headRefName: pr.headRefName!, baseRefName: "main",
      headOid: head, baseOid: "b".repeat(40), state: "OPEN", isDraft: false, isCrossRepository: false, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE", needsPreparation: false, readiness: "ready", detail: "", unresolvedThreads: 0, threadsComplete: true, checks: "passed", basePrNumber: null,
      approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] }, ...patch } };
  };
  /** GitHub answers for full reads, keyed by PR; the cheap read finds nothing new. */
  const github = (reads: Record<string, () => unknown>): { call: HostCall } => ({ call: (method, input) =>
    method === "inspectPrs" ? { entries: [], closed: [], failed: [], warnings: [] } : method === "advanceInspect" ? reads[input.prUrl]?.() : undefined });
  async function instructed(effortName = "Catalog follow-ups", host: { call?: HostCall } = {}) {
    const env = await setup(INKWELL_ROSTER, host);
    const work = createEffortWorkStore(env.db);
    const effort = env.efforts[effortName]!;
    work.setMode(effort.id, "v2", 0, () => []);
    const first = await env.roster(effort.id);
    let request = 0;
    const command = async (text: string, extra: Record<string, unknown> = {}) => await env.harness.callRpc("effort_command",
      { effortId: effort.id, snapshotId: first.snapshotId, text, requestId: `req-${++request}`, source: "panel", ...extra }) as EffortCommandResult;
    const admit = async (text: string, extra: Record<string, unknown> = {}) => {
      const result = await command(text, extra);
      if (result.kind !== "admit") throw new Error(`Expected ${text} to be admitted: ${result.message}`);
      return result;
    };
    /** A command admitted in another effort. */
    const admitIn = async (effortId: string, text: string, snapshotId: string | null = null) => {
      const result = await env.harness.callRpc("effort_command", { effortId, snapshotId, text, requestId: `req-${++request}`, source: "panel" }) as EffortCommandResult;
      if (result.kind !== "admit") throw new Error(`Expected ${text} to be admitted: ${result.message}`);
      return result;
    };
    const n = (target: string) => first.rows.find((row) => row.target === target)!.n;
    const rows = () => work.rows(effort.id).sort((a, b) => (a.body.n ?? Infinity) - (b.body.n ?? Infinity))
      .map((row) => [row.body.n ?? row.target, row.phase, row.body.cause, row.body.userState]);
    const count = (table: string) => (env.db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
    const transitions = (target: string) => env.db.prepare(`SELECT row_revision AS revision, to_phase AS phase, source FROM effort_transitions WHERE target = ? ORDER BY seq`)
      .all(prWorkItemKey(target)) as { revision: number; phase: string; source: string }[];
    return { ...env, work, effort, first, command, admit, admitIn, n, rows, count, transitions };
  }

  it("acknowledges what is included, left out, held, and superseded, with effects, stop point, report mode, evidence contract, and each PR's planned step", async () => {
    const env = await instructed();
    await env.harness.callRpc("pr_hold_set", { prUrl: env.first.rows[4]!.target, held: true, reason: "waiting on the style guide" });
    const admitted = await env.admit("Move 1-6 forward, leave 3 alone, and tell me only what needs a decision");
    expect(admitted.revision).toBe(1);
    expect(admitted.acknowledgment).toEqual([
      "Instruction r1 · 5 PRs · stops at Ready · reports decisions only",
      "Added: 1, 2, 4-6 (move forward)",
      "Left alone this instruction, not a hold: 3",
      "Held, skipped until released (a hold outlasts every instruction): 5",
      "Effects: 1, 2, 4-6 fix · test · push · reply · resolve threads · retarget · rerun failed checks · re-request review",
      "Next (planned; nothing runs until v2 execution is on): 1, 2, 4, 6 read GitHub; 5 paused: hold",
    ]);
    expect(admitted.rollup).toEqual([
      "Outcome: Catalog follow-ups goal · 5 PRs: 1, 2, 4-6",
      "Validated: nothing yet",
      "Still needed: branch, checks, feedback, review, dependencies, merge: read GitHub (1, 2, 4, 6); also 5 · v2 · wake: the next reconciler pass; 5 tickets: their PRs (1, 2, 4-6)",
      "Needs a decision: none",
    ]);
    expect(env.rows()).toEqual([[1, "verifying", "observe", "waiting"], [2, "verifying", "observe", "waiting"], [4, "verifying", "observe", "waiting"],
      [5, "paused", "hold", "waiting"], [6, "verifying", "observe", "waiting"]]);
    const replaced = await env.admit("only move 7-9 forward");
    expect(replaced.acknowledgment).toEqual(expect.arrayContaining(["Superseded: 1, 2, 4-6", "Next (planned; nothing runs until v2 execution is on): 7-9 read GitHub"]));
    expect(env.rows().filter(([, phase]) => phase !== "finished").map(([n]) => n)).toEqual([7, 8, 9]);
    expect(env.rows().filter(([, , cause]) => cause === "superseded").map(([n]) => n)).toEqual([1, 2, 4, 5, 6]);
    // The roster shows the instruction's rows in their user states, and its rollup.
    const roster = await env.roster(env.effort.id);
    expect(roster).toMatchObject({ instruction: { revision: 2, text: "only move 7-9 forward", reportMode: "decisions-only" }, rollup: replaced.rollup });
    expect(roster.rows.slice(0, 9).map((row) => [row.n, row.state, row.cause, row.modifiers])).toEqual([
      ...[1, 2, 3, 4].map((n) => [n, "not-in-instruction", "review", []]), [5, "not-in-instruction", "hold", []], [6, "not-in-instruction", "review", []],
      ...[7, 8, 9].map((n) => [n, "waiting", "observe", ["plan only"]])]);
  });

  it("corrects the evidence contract with done when and drop cN, each as an instruction revision", async () => {
    const env = await instructed();
    await env.admit("move 1-3 forward");
    const criterion = await env.admit("done when 2: the follow-up link opens its catalog entry");
    expect(criterion).toMatchObject({ revision: 2, acknowledgment: expect.arrayContaining(["Criterion c1 (2): the follow-up link opens its catalog entry"]) });
    expect(criterion.rollup![2]).toContain("c1");
    const dropped = await env.admit("drop c1");
    expect(dropped).toMatchObject({ revision: 3, acknowledgment: expect.arrayContaining(["Dropped criterion c1: the follow-up link opens its catalog entry"]) });
    expect(dropped.rollup![2]).not.toContain("c1");
    expect(env.db.prepare(`SELECT revision, status FROM effort_instructions ORDER BY revision`).all()).toEqual([
      { revision: 1, status: "superseded" }, { revision: 2, status: "superseded" }, { revision: 3, status: "active" }]);
    expect(env.work.instruction(env.effort.id)!.scope.criteria).toEqual([expect.objectContaining({ id: "c1", droppedInRevision: 3 })]);
  });

  it("includes an unowned PR outside membership without changing membership, numbers it, and fences it from legacy Advance", async () => {
    const future = INKWELL_ROSTER.future;
    const env = await instructed("Catalog follow-ups", github({ [future]: () => facts(future) }));
    const before = env.store.get(env.effort.id)!.members;
    const admitted = await env.admit(`move 1, ${future} forward`);
    expect(admitted.acknowledgment).toContain(`Outside membership, membership unchanged: ${future}`);
    expect(env.store.get(env.effort.id)!.members).toEqual(before);
    const row = (await env.roster(env.effort.id)).rows.find((item) => item.target === future);
    expect(row).toMatchObject({ n: 32, outsideMembership: true, state: "waiting", cause: "observe" });
    const preview = await env.harness.callRpc("advance_preview", { prUrls: [future] }) as { jobs: { eligible: boolean; detail: string }[] };
    expect(preview.jobs).toEqual([expect.objectContaining({ eligible: false, detail: "Managed by the Catalog follow-ups roster; instruct there." })]);
    // Refresh reaches it too, though it isn't a member.
    expect(await env.reconcile(env.effort.id, future)).toMatchObject({ status: "checked", row: { target: future, outsideMembership: true } });
  });

  it("lets the new owner's instruction take over a PR whose membership moved, and the old roster neither fences nor plans it again", async () => {
    const future = INKWELL_ROSTER.future;
    const env = await instructed("Catalog follow-ups", github({ [future]: () => facts(future) }));
    const vault = env.efforts["Vault audits"]!;
    await env.admit(`move 1, ${future} forward`);
    env.store.transfer(vault.key, { tickets: [], prUrls: [future] });
    await env.admit("move 2 forward");
    expect(env.work.row(future)).toMatchObject({ effortId: env.effort.id, phase: "paused", body: { cause: "membership-moved" } });
    // Vault runs on legacy launchers, and the paused row doesn't keep them out.
    const preview = await env.harness.callRpc("advance_preview", { prUrls: [future] }) as { jobs: { detail: string }[] };
    expect(preview.jobs[0]!.detail).not.toContain("Managed by");
    // Once Vault is on its roster, its instruction takes the row over, where it wakes.
    env.work.setMode(vault.id, "v2", 0, () => []);
    await env.admitIn(vault.id, `move ${future} forward`);
    expect(env.work.row(future)).toMatchObject({ effortId: vault.id, phase: "verifying", body: { cause: "observe" } });
    // Catalog's instruction still names it, but Catalog's commands leave Vault's row alone.
    await env.admit("move 3 forward");
    expect(env.work.row(future)).toMatchObject({ effortId: vault.id, phase: "verifying" });
    expect(env.rows().map(([n]) => n)).toEqual([1, 2, 3]);
  });

  it("pauses rows as v2-off when the effort opts out, and another effort can include a PR it had from outside membership", async () => {
    const future = INKWELL_ROSTER.future;
    const env = await instructed();
    const vault = env.efforts["Vault audits"]!;
    await env.admit(`move 1, ${future} forward`);
    await env.harness.callRpc("effort_v2_set", { effortId: env.effort.id, mode: "legacy", expectedRevision: 1 });
    expect(env.rows()).toEqual([[1, "paused", "v2-off", "waiting"], [future, "paused", "v2-off", "waiting"]]);
    expect(env.transitions(future).at(-1)).toMatchObject({ phase: "paused", source: "mode" });
    env.work.setMode(vault.id, "v2", 0, () => []);
    await env.admitIn(vault.id, `move ${future} forward`);
    expect(env.work.row(future)).toMatchObject({ effortId: vault.id, phase: "verifying" });
    // Back on its roster, Catalog resumes its own rows and plans around Vault's.
    env.work.setMode(env.effort.id, "v2", 2, () => []);
    await env.admit("move 2 forward");
    expect(env.rows()).toEqual([[1, "verifying", "observe", "waiting"], [2, "verifying", "observe", "waiting"]]);
    expect(env.work.row(future)!.effortId).toBe(vault.id);
  });

  it("numbers a PR another effort let go by this roster, never by the other effort's number", async () => {
    const future = INKWELL_ROSTER.future;
    const env = await instructed();
    const vault = env.efforts["Vault audits"]!;
    env.work.setMode(vault.id, "v2", 0, () => []);
    await env.admitIn(vault.id, `move 1, ${future} forward`, (await env.roster(vault.id)).snapshotId);
    const numbered = await env.roster(vault.id);
    const theirs = numbered.rows.find((row) => row.target === future)!.n;
    await env.admitIn(vault.id, `drop ${theirs}`, numbered.snapshotId);
    expect(env.work.row(future)).toMatchObject({ effortId: vault.id, phase: "finished", body: { n: theirs } });
    const admitted = await env.admit(`move 1, ${future} forward`);
    expect(env.work.row(future)).toMatchObject({ effortId: env.effort.id, body: { n: null } });
    expect(admitted.acknowledgment.at(-1)).toBe(`Next (planned; nothing runs until v2 execution is on): 1, ${future} read GitHub`);
    expect(admitted.rollup![0]).toBe(`Outcome: Catalog follow-ups goal · 2 PRs: 1, ${future}`);
  });

  it("admits nothing when a PR belongs to another effort, and returns one command for each effort that owns a named PR", async () => {
    const env = await instructed();
    const [vault, shelving] = [INKWELL_ROSTER.efforts[2]!.prUrls[0]!, INKWELL_ROSTER.efforts[1]!.prUrls[0]!];
    const result = await env.command(`move 1, ${vault}, ${shelving} forward`);
    expect(result).toMatchObject({ kind: "clarify" });
    expect(result.kind === "clarify" && result.message.split("\n")).toEqual([
      expect.stringMatching(/^Nothing was admitted: .* belong to other efforts/u),
      `Vault audits: move ${vault} forward`, `Shelving entry: move ${shelving} forward`, "Here: move 1 forward"]);
    // A PR another effort's instruction includes from outside is that effort's too.
    const vaultWork = createEffortWorkStore(env.db);
    const vaultEffort = env.efforts["Vault audits"]!;
    vaultWork.setMode(vaultEffort.id, "v2", 0, () => []);
    expect(await env.harness.callRpc("effort_command", { effortId: vaultEffort.id, snapshotId: null, text: `move ${INKWELL_ROSTER.future} forward`,
      requestId: "vault-1", source: "panel" })).toMatchObject({ kind: "admit" });
    expect(await env.command(`move ${INKWELL_ROSTER.future} forward`)).toMatchObject({ kind: "clarify",
      message: expect.stringContaining(`Vault audits: move ${INKWELL_ROSTER.future} forward`) });
    expect([env.count("effort_pr_work"), env.work.lastRevision(env.effort.id)]).toEqual([1, 0]);
  });

  it("pauses an archived effort's rows without refusing the archive, and resumes them on restore", async () => {
    const env = await instructed();
    await env.admit("move 1-3 forward");
    const archive = async (archived: boolean) => {
      const { scopes } = await env.harness.callRpc("effort_admin_list", null) as { scopes: Record<string, string> };
      return env.harness.callRpc("effort_admin_archive", { effortKey: env.effort.key, archived, expectedScope: scopes[env.effort.key]! });
    };
    expect(await archive(true)).toMatchObject({ ok: true });
    expect(env.rows()).toEqual([1, 2, 3].map((n) => [n, "paused", "archived", "waiting"]));
    expect(env.db.prepare(`SELECT count(*) AS count FROM effort_transitions WHERE source = 'archive'`).get()).toEqual({ count: 3 });
    expect(await env.command("move 4 forward")).toMatchObject({ kind: "clarify", message: expect.stringContaining("Restore Catalog follow-ups") });
    expect(await archive(false)).toMatchObject({ ok: true });
    expect(env.rows()).toEqual([1, 2, 3].map((n) => [n, "verifying", "observe", "waiting"]));
  });

  it("pauses an instructed PR on a hold set from the board and resumes it on release", async () => {
    const env = await instructed();
    await env.admit("move 1-2 forward");
    const [one, two] = [env.first.rows[0]!.target, env.first.rows[1]!.target];
    await env.harness.callRpc("pr_hold_set", { prUrl: one, held: true, reason: "the style guide is changing" });
    expect(env.rows()).toEqual([[1, "paused", "hold", "waiting"], [2, "verifying", "observe", "waiting"]]);
    await env.harness.callRpc("pr_hold_set", { prUrl: one, held: false });
    expect(env.rows()).toEqual([[1, "verifying", "observe", "waiting"], [2, "verifying", "observe", "waiting"]]);
    expect(env.transitions(one)).toEqual([{ revision: 1, phase: "verifying", source: "command" }, { revision: 2, phase: "paused", source: "hold" },
      { revision: 3, phase: "verifying", source: "hold" }]);
    expect(env.transitions(two)).toEqual([{ revision: 1, phase: "verifying", source: "command" }]);
  });

  it("rewrites only the rows whose step a command changed", async () => {
    const env = await instructed();
    await env.admit("move 1-3 forward");
    const before = [0, 1, 2].map((index) => env.transitions(env.first.rows[index]!.target));
    await env.admit("move 4 forward");
    expect([0, 1, 2].map((index) => env.transitions(env.first.rows[index]!.target))).toEqual(before);
    expect(env.transitions(env.first.rows[3]!.target)).toEqual([{ revision: 1, phase: "verifying", source: "command" }]);
  });

  it("keeps a whole-effort criterion on its lowest-numbered PR when a refresh re-plans only another row", async () => {
    const env = await instructed("Catalog follow-ups", { call: (method, input) => method === "inspectPrs" ? { entries: [], closed: [], failed: [], warnings: [] }
      : method === "advanceInspect" ? facts(input.prUrl) : undefined });
    await env.admit("move 1-3 forward");
    await env.admit("recheck 1-3");
    const criterion = await env.admit("done when: the catalog loads");
    expect(criterion.acknowledgment.at(-1)).toBe("Next (planned; nothing runs until v2 execution is on): 1 validate_criteria; 2, 3 merge through its fresh preview");
    const planned = [[1, "queued", "launching", "waiting"], [2, "prepared", "merge-candidate", "ready"], [3, "prepared", "merge-candidate", "ready"]];
    expect(env.rows()).toEqual(planned);
    const [one, , three] = env.first.rows.map((row) => row.target);
    const history = env.transitions(one!);
    await env.reconcile(env.effort.id, three!);
    expect(env.rows()).toEqual(planned);
    // The refresh recorded row 3's new read, and nothing else.
    expect(env.transitions(three!).at(-1)).toMatchObject({ phase: "prepared", source: "refresh" });
    expect(env.transitions(one!)).toEqual(history);
  });

  it("waits for another writer in a PR's checkout before planning a launch there", async () => {
    const env = await instructed("Catalog follow-ups", github({ [catalog96]: () => facts(catalog96, { checks: "failed" }) }));
    const n = env.n(catalog96);
    const checkout = env.first.rows.find((row) => row.target === catalog96)!.checkouts[0]!;
    // A ticket-level action names no PR, but it writes in this PR's checkout.
    createRunStore(env.db).begin({ path: checkout, ticket: "ABC-120", prUrl: null, prNumber: null, action: "investigate-ci", mode: "new", threadId: null });
    await env.admit(`move ${n} forward`);
    expect((await env.admit(`recheck ${n}`)).acknowledgment.at(-1)).toBe(`Next (planned; nothing runs until v2 execution is on): ${n} wait: writer-available`);
    expect(env.work.row(catalog96)).toMatchObject({ phase: "waiting", body: { cause: "writer-available", detail: expect.stringMatching(/^Action run \d+ is writing this PR$/u) } });
  });

  it("answers a repeated request with its first result and changes nothing again", async () => {
    const env = await instructed();
    const first = await env.admit("move 1-3 forward", { requestId: "req-once" });
    expect(await env.command("move 1-9 forward", { requestId: "req-once" })).toEqual(first);
    const held = await env.admit("hold 4 because the style guide is changing", { requestId: "req-hold" });
    expect(await env.command("hold 4 because the style guide is changing", { requestId: "req-hold" })).toEqual(held);
    expect([env.count("effort_instructions"), env.count("effort_pr_work"), env.count("pr_holds")]).toEqual([1, 3, 1]);
    expect(env.db.prepare(`SELECT count(*) AS count FROM effort_transitions WHERE cause = 'command'`).get()).toEqual({ count: 2 });
  });

  it("keeps a PR that joins the effort later out of scope until a command names it", async () => {
    const env = await instructed();
    await env.admit("move all forward");
    env.store.transfer(env.effort.key, { tickets: [], prUrls: [INKWELL_ROSTER.future] });
    const joined = (await env.roster(env.effort.id)).rows.find((row) => row.target === INKWELL_ROSTER.future);
    expect(joined).toMatchObject({ n: 32, state: "not-in-instruction" });
    // `all` still means the roster the command was written against.
    await env.admit("move all forward");
    expect(env.work.instruction(env.effort.id)!.scope.include.map((grant) => grant.target)).not.toContain(INKWELL_ROSTER.future);
    expect(env.work.row(INKWELL_ROSTER.future)).toBeNull();
  });

  it("rechecks a PR from a fresh read, naming exactly what keeps it from Ready, and resets its row into a new retry epoch, keeping history", async () => {
    let checks = "failed";
    const env = await instructed("Catalog follow-ups", github({ [catalog96]: () => facts(catalog96, { checks }) }));
    const n = env.n(catalog96);
    await env.admit(`move ${n} forward`);
    const failing = await env.admit(`recheck ${n}`);
    expect(failing.acknowledgment).toEqual([`Recheck: ${n}`, `Recheck ${n}: short of Ready: checks-green`,
      `Next (planned; nothing runs until v2 execution is on): ${n} fix_failing_checks`]);
    expect(env.work.row(catalog96)).toMatchObject({ phase: "queued", body: { cause: "launching", detail: "fix_failing_checks once its checkout and thread are read", retryEpoch: 0 } });
    checks = "passed";
    const ready = await env.admit(`recheck ${n}`);
    expect(ready.acknowledgment).toEqual([`Recheck: ${n}`, `Recheck ${n}: Ready`, `Next (planned; nothing runs until v2 execution is on): ${n} merge through its fresh preview`]);
    expect(env.work.row(catalog96)).toMatchObject({ phase: "prepared", body: { userState: "ready" } });
    const transitions = () => env.db.prepare(`SELECT row_revision AS revision, to_phase AS phase FROM effort_transitions WHERE target = ? ORDER BY seq`).all(catalog96);
    const history = transitions();
    await env.admit(`reset ${n}`);
    expect(env.work.row(catalog96)).toMatchObject({ phase: "prepared", body: { retryEpoch: 1 } });
    expect(transitions()).toEqual([...history, { revision: history.length + 1, phase: "prepared" }]);
    expect(env.harness.inspection.experimental_hostRpcCalls.filter((call) => call.method === "advanceInspect")).toHaveLength(2);
  });

  it("serves an effort parent thread its counts, rollup, snapshot, and revision, and nothing to any other thread", async () => {
    const env = await instructed();
    env.store.save({ ...env.store.getRecord(env.effort.id)!, coordinatorThreadId: "thr_catalog_parent", coordinatorState: "ready" });
    const context = async (threadId: string) => env.harness.callRpc("effort_parent_context", { threadId });
    expect(await context("thr_catalog_parent")).toMatchObject({ revision: null, lastRevision: 0, rollup: null, snapshotId: env.first.snapshotId,
      counts: { doing: 0, waiting: 0, decision: 0, ready: 0, issue: 0, done: 0 } });
    const admitted = await env.admit("move 1-3 forward");
    expect(await context("thr_catalog_parent")).toEqual({ effort: { id: env.effort.id, key: env.effort.key, name: "Catalog follow-ups", archived: false },
      snapshotId: env.first.snapshotId, revision: 1, lastRevision: 1, rollup: admitted.rollup, counts: { doing: 0, waiting: 3, decision: 0, ready: 0, issue: 0, done: 0 } });
    expect(await context("thr_someone_else")).toBeNull();
    createEffortWorkStore(env.db).setMode(env.effort.id, "legacy", 1, () => []);
    expect(await context("thr_catalog_parent")).toBeNull();
  });

  it("blocks merging efforts while either has an active instruction", async () => {
    const env = await instructed();
    const shelving = env.efforts["Shelving entry"]!;
    env.work.setMode(shelving.id, "v2", 0, () => []);
    const preview = async () => (await env.harness.callRpc("effort_admin_merge_preview", { sourceKey: env.effort.key, destinationKey: shelving.key }) as
      { ok: true; preview: { blockers: string[] } }).preview.blockers;
    expect(await preview()).toEqual([]);
    await env.admit("move 1 forward");
    expect(await preview()).toEqual(["Catalog follow-ups has an active instruction. Cancel it, or let it complete, before merging."]);
    await env.admit("cancel", { expectedRevision: 1 });
    expect(await preview()).toEqual([]);
    // An instruction that becomes active after the merge's own preview, just before its transaction, still stops it.
    const { scope } = (await env.harness.callRpc("effort_admin_merge_preview", { sourceKey: env.effort.key, destinationKey: shelving.key }) as { ok: true; preview: { scope: string } }).preview;
    const transaction = env.db.transaction.bind(env.db);
    vi.spyOn(env.db, "transaction").mockImplementationOnce((fn) => transaction((...args: unknown[]) => {
      env.db.prepare(`UPDATE effort_instructions SET status = 'active' WHERE effort_id = ?`).run(env.effort.id);
      return fn(...args);
    }));
    expect(await env.harness.callRpc("effort_admin_merge", { sourceKey: env.effort.key, destinationKey: shelving.key, expectedScope: scope }))
      .toEqual({ ok: false, error: expect.stringContaining("An instruction became active for these efforts. Reopen the merge preview.") });
    expect(env.store.get(env.effort.id)!.mergedInto ?? null).toBeNull();
  });

  it("refuses commands for an effort on legacy launchers, and makes no SDK or GitHub write for any command", async () => {
    const env = await instructed();
    const legacy = env.efforts["Vault audits"]!;
    expect(await env.harness.callRpc("effort_command", { effortId: legacy.id, snapshotId: null, text: "move 1 forward", requestId: "legacy-1", source: "banner" }))
      .toEqual({ kind: "clarify", normalized: null, message: "Vault audits runs on legacy launchers. Move it to its roster before instructing it there." });
    for (const text of ["move 1-6 forward, leave 3 alone", "hold 2", "release 2", "reset 1", "done when 4: the notes render", "only move 7 forward", "cancel"])
      expect((await env.command(text)).kind, text).toBe("admit");
    for (const path of ["threads.spawn", "threads.send", "threads.update"]) expect(env.harness.inspection.sdk.callsTo(path)).toEqual([]);
    expect(env.harness.inspection.experimental_hostRpcCalls.filter((call) => ["prWrite", "advanceWorkspace"].includes(call.method))).toEqual([]);
  });
});
