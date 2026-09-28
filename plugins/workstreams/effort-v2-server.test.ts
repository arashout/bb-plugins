import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawUnit } from "./contract.js";
import type { EffortRoster, RosterRow } from "./effort-roster.js";
import { cheapSignature } from "./effort-roster-store.js";
import { RECIPES } from "./effort-recipes.js";
import { createEffortStore } from "./effort-store.js";
import { INKWELL_ROSTER } from "./inkwell-fixtures.js";
import { createLinearSync } from "./linearsync.js";
import { createRunStore } from "./runstore.js";
import { dryRun, openReadOnly } from "./scripts/roster-dry-run.js";
import plugin, { type Board } from "./server.js";

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
