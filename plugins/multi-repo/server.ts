/**
 * The server entry: the environment provider, the agent surface, the CLI, and
 * the frontend's data plane.
 *
 * Three entry points in one package (server, host, app) because `bb.storage`
 * and RPC routes are namespaced per plugin: the panel needs the manifests the
 * provider writes, and splitting provisioning from UI would mean one plugin
 * reaching into another's state, which bb does not offer and should not.
 *
 * Nothing here touches a filesystem. Every path operation goes to `host.ts` on
 * the machine that holds the repos — a plugin's `run` and RPC handlers execute
 * on the *server*, which on a multi-machine install is a different computer
 * from the one the workspace lives on.
 */
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import type { PluginEnvironmentProviderProgress } from "@get-bb/plugin-sdk/environment-provider";
import { z } from "zod";
import {
  hostContract,
  hostSignals,
  rpcContract,
  type CacheEntry,
  type RepoPullRequest,
  type RepoRequest,
  type RepoTarget,
} from "./contract.js";
import {
  describeRepo,
  formatInstructions,
  readyRepos,
  type WorkspaceManifest,
  type WorkspaceRepo,
} from "./layout.js";
import {
  EMPTY_REPOS,
  MAX_REPOS,
  REPOS_FILE,
  addRepo,
  dirFromUrl,
  findRepo,
  parseReposFile,
  removeRepo,
  serializeReposFile,
  type ReposFile,
} from "./repos.js";
import { PROJECT_SOURCE_DIR, normalizeRemoteUrl } from "./paths.js";
import {
  CACHE_BACKGROUND_MS,
  CACHE_FRESH_MS,
  ENVIRONMENT_PROVIDER_ID,
  MAX_DIFF_FILES,
  MAX_PATCH_BYTES,
  PR_CACHE_TTL_MS,
  REPOS_CHANGED_CHANNEL,
} from "./shared.js";

const CREATE_TIMEOUT_MS = 60 * 60 * 1000;
const REMOVE_TIMEOUT_MS = 10 * 60 * 1000;
const READ_TIMEOUT_MS = 90_000;
const ACTION_TIMEOUT_MS = 10 * 60 * 1000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function multiRepoPlugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    searchRoot: {
      type: "string",
      label: "Extra search root",
      default: "",
      experimental_schema: z
        .string()
        .max(4096)
        .refine((value) => value === "" || value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value), {
          message: "Must be an absolute path, or empty.",
        }),
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS workspaces (
       host_id TEXT NOT NULL,
       path_key TEXT NOT NULL,
       thread_id TEXT NOT NULL,
       project_id TEXT NOT NULL,
       root TEXT NOT NULL,
       branch_name TEXT NOT NULL,
       project_source_path TEXT NOT NULL,
       repos TEXT NOT NULL,
       instructions TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       PRIMARY KEY (host_id, path_key)
     )`,
    `CREATE INDEX IF NOT EXISTS workspaces_thread ON workspaces (thread_id)`,
    `CREATE TABLE IF NOT EXISTS pr_cache (
       thread_id TEXT NOT NULL,
       dir TEXT NOT NULL,
       payload TEXT NOT NULL,
       fetched_at INTEGER NOT NULL,
       PRIMARY KEY (thread_id, dir)
     )`,
  ]);

  const host = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });

  /**
   * Live launch reports, keyed by the operation id the host echoes back.
   *
   * The host worker cannot reach `context.report` directly, so a long call
   * emits `progress` signals and this map routes each one to the launch that
   * is waiting on it.
   */
  const reports = new Map<string, PluginEnvironmentProviderProgress>();
  host.experimental_onSignal("progress", (event) => {
    const report = reports.get(event.payload.operationId);
    if (report === undefined) return;
    if (event.payload.kind === "step") report.step(event.payload.text);
    else report.log(event.payload.text);
  });

  /* ------------------------------------------------------------ storage */

  function saveManifest(manifest: WorkspaceManifest): void {
    db.prepare(
      `INSERT INTO workspaces
         (host_id, path_key, thread_id, project_id, root, branch_name, project_source_path, repos, instructions, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (host_id, path_key) DO UPDATE SET
         thread_id = excluded.thread_id,
         project_id = excluded.project_id,
         root = excluded.root,
         branch_name = excluded.branch_name,
         project_source_path = excluded.project_source_path,
         repos = excluded.repos,
         instructions = excluded.instructions,
         created_at = excluded.created_at`,
    ).run(
      manifest.hostId,
      manifest.pathKey,
      manifest.threadId,
      manifest.projectId,
      manifest.root,
      manifest.branchName,
      manifest.projectSourcePath,
      JSON.stringify(manifest.repos),
      formatInstructions(manifest),
      manifest.createdAt,
    );
  }

  function rowToManifest(row: Record<string, unknown>): WorkspaceManifest | null {
    try {
      return {
        hostId: String(row.host_id),
        pathKey: String(row.path_key),
        threadId: String(row.thread_id),
        projectId: String(row.project_id),
        root: String(row.root),
        branchName: String(row.branch_name),
        projectSourcePath: String(row.project_source_path),
        repos: JSON.parse(String(row.repos)) as WorkspaceRepo[],
        createdAt: Number(row.created_at),
      };
    } catch {
      return null;
    }
  }

  /** Synchronous on purpose — `contributeInstructions` cannot await. */
  function manifestForThread(threadId: string): WorkspaceManifest | null {
    const row = db
      .prepare(`SELECT * FROM workspaces WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(threadId) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToManifest(row);
  }

  function instructionsForThread(threadId: string): string | null {
    const row = db
      .prepare(`SELECT instructions FROM workspaces WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(threadId) as { instructions?: unknown } | undefined;
    const text = row?.instructions;
    return typeof text === "string" && text.length > 0 ? text : null;
  }

  function forgetWorkspace(hostId: string, pathKey: string): void {
    const row = db
      .prepare(`SELECT thread_id FROM workspaces WHERE host_id = ? AND path_key = ?`)
      .get(hostId, pathKey) as { thread_id?: unknown } | undefined;
    db.prepare(`DELETE FROM workspaces WHERE host_id = ? AND path_key = ?`).run(hostId, pathKey);
    if (typeof row?.thread_id === "string") {
      db.prepare(`DELETE FROM pr_cache WHERE thread_id = ?`).run(row.thread_id);
    }
  }

  function changed(): void {
    bb.realtime.publish(REPOS_CHANGED_CHANNEL, { at: Date.now() });
  }

  /* ------------------------------------------------- the project source */

  interface SourceLocation {
    hostId: string;
    path: string;
  }

  /**
   * Where this project's `.bb` checkout lives, and on which machine.
   *
   * A project can have a source on several machines — core keeps one per
   * `(project, host)`. The server's own machine is preferred because that is
   * where an RPC or CLI call can reach a host worker with the least surprise;
   * anything else is a reasonable fallback rather than a guess.
   */
  async function projectSource(projectId: string): Promise<SourceLocation | null> {
    const project = await bb.sdk.projects.get({ projectId });
    const sources = project.sources.filter((source) => source.type === "local_path");
    if (sources.length === 0) return null;
    const primary = (await bb.sdk.system.config()).primaryHostId;
    const preferred =
      sources.find((source) => source.hostId === primary) ??
      sources.find((source) => source.isDefault) ??
      sources[0];
    return { hostId: preferred.hostId, path: preferred.path };
  }

  /**
   * Read the repo set.
   *
   * `bootstrap` is true only where an absent `.git` genuinely should be
   * created — provisioning, and the commands that are about to commit to it.
   * A panel refresh or `bb repos list` must not `git init` a directory as a
   * side effect of looking at it.
   */
  async function readRepoSet(
    location: SourceLocation,
    options: { bootstrap: boolean },
    signal?: AbortSignal,
  ): Promise<{ text: string | null; file: ReposFile | null; error: string | null }> {
    const prepared = await host.call(
      "prepareProjectSource",
      { path: location.path, fetchTtlMs: CACHE_FRESH_MS, bootstrap: options.bootstrap },
      { hostId: location.hostId, timeoutMs: READ_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
    );
    if (prepared.reposJson === null) return { text: null, file: EMPTY_REPOS, error: null };
    const parsed = parseReposFile(prepared.reposJson);
    return parsed.ok
      ? { text: prepared.reposJson, file: parsed.value, error: null }
      : { text: prepared.reposJson, file: null, error: parsed.error };
  }

  async function writeRepoSet(
    location: SourceLocation,
    file: ReposFile,
    message: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await host.call(
      "writeProjectSourceRepos",
      { path: location.path, reposJson: serializeReposFile(file), message },
      { hostId: location.hostId, timeoutMs: READ_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
    );
    // The file is written either way, but an uncommitted change is not shared
    // with anyone else and will confuse the next person to pull. Say so rather
    // than reporting success.
    if (!result.committed && result.message !== null) {
      throw new Error(`${REPOS_FILE} was written but not committed: ${result.message}`);
    }
    changed();
  }

  /**
   * Every git checkout bb knows about on one machine.
   *
   * Feeds two things: the object cache's local-mirror step, and the repo-set
   * proposal for a project that has none. Failure is never fatal — the worst
   * case is a cold network clone, which is what would have happened anyway.
   */
  async function localCheckouts(
    hostId: string,
    projectSourcePath: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; url: string }[]> {
    try {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      const paths = new Set<string>();
      for (const project of projects) {
        for (const source of project.sources) {
          if (source.type === "local_path" && source.hostId === hostId) paths.add(source.path);
        }
      }
      paths.delete(projectSourcePath);
      const configured = (await settings.get()).searchRoot;
      const searchRoots = [parentOf(projectSourcePath), ...(configured.length > 0 ? [configured] : [])];
      const result = await host.call(
        "discoverCheckouts",
        { paths: [...paths].slice(0, 500), searchRoots },
        { hostId, timeoutMs: READ_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
      );
      return result.checkouts;
    } catch (error) {
      bb.log.warn(`Could not enumerate local checkouts on ${hostId}: ${errorMessage(error)}`);
      return [];
    }
  }

  function parentOf(target: string): string {
    const normalized = target.replace(/[\\/]+$/u, "");
    const cut = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
    return cut <= 0 ? normalized : normalized.slice(0, cut);
  }

  /* ---------------------------------------------- the environment provider */

  bb.experimental_environments.register({
    id: ENVIRONMENT_PROVIDER_ID,
    displayName: "Multi-repo workspace",
    description: "One directory per thread, holding a checkout of every repo in the project.",
    icon: "FolderGit",
    // `projectCheckout` guarantees a non-null `context.projectCheckout.path`
    // with no git availability gating — that only fires for `gitCheckout`,
    // and the project source here may legitimately not be a repo yet.
    requires: { projectCheckout: true },
    // Both defaults, taken deliberately. `per-thread` path keys mean a rebuild
    // re-clones every repo, which is the right trade against serving a
    // half-torn-down workspace — and the object cache keeps that cost local.
    // The five-minute retire grace is right too: keeping these indefinitely
    // would accumulate a full checkout set per thread on the machine's disk.
    policy: { pathKeys: "per-thread", retireGraceMs: 5 * 60 * 1000 },

    async create(context) {
      const hostId = context.host.id;
      const operationId = `create#${context.pathKey}#${context.attempt}`;
      reports.set(operationId, context.report);
      try {
        context.report.step("Reading the project definition");
        const location: SourceLocation = { hostId, path: context.projectCheckout.path };
        const prepared = await host.call(
          "prepareProjectSource",
          { path: location.path, fetchTtlMs: CACHE_FRESH_MS, bootstrap: true },
          { hostId, signal: context.signal, timeoutMs: READ_TIMEOUT_MS },
        );
        for (const warning of prepared.warnings) context.report.log(warning);
        if (prepared.bootstrapped) {
          context.report.log(`Initialized a new project definition in ${location.path}`);
        }

        let repoSet: ReposFile;
        if (prepared.reposJson === null) {
          repoSet = EMPTY_REPOS;
        } else {
          const parsed = parseReposFile(prepared.reposJson);
          if (!parsed.ok) {
            // `repos.json` is on the critical path for every thread in the
            // project, so the failure names the offending entry rather than
            // producing a mysteriously empty workspace.
            return { status: "failed", message: parsed.error };
          }
          repoSet = parsed.value;
        }

        context.report.step("Looking for repos already on this machine");
        const mirrors = await localCheckouts(hostId, location.path, context.signal);

        if (repoSet.repos.length === 0) {
          const seeded = proposeRepoSet(mirrors);
          if (seeded.repos.length === 0) {
            return {
              status: "failed",
              message: `No repos are configured. Add some to ${REPOS_FILE} in ${location.path}, or run \`bb repos add <url>\`.`,
            };
          }
          context.report.log(
            `Seeding an empty repo set with ${seeded.repos.length} repo(s) found on this machine: ${seeded.repos
              .map((repo) => repo.dir)
              .join(", ")}`,
          );
          await writeRepoSet(location, seeded, "Seed the repo set from checkouts on this machine", context.signal);
          repoSet = seeded;
        }

        // Claim before writing. Two environments must never share a root, and
        // the claim is what makes that core's answer rather than a race here.
        const root = await plannedRoot(hostId, context.pathKey);
        if (root !== null && !(await context.experimental_claimPath(root))) {
          return { status: "failed", message: `${root} is already in use by another environment.` };
        }

        context.report.step(`Preparing ${repoSet.repos.length} repo(s)`);
        const provisioned = await host.call(
          "provisionWorkspace",
          {
            operationId,
            pathKey: context.pathKey,
            projectSourcePath: location.path,
            repos: repoSet.repos.map(toRepoRequest),
            branchName: context.suggestedBranchName,
            fetchTtlMs: CACHE_FRESH_MS,
            mirrors,
          },
          { hostId, signal: context.signal, timeoutMs: CREATE_TIMEOUT_MS },
        );

        const manifest: WorkspaceManifest = {
          root: provisioned.root,
          pathKey: context.pathKey,
          hostId,
          threadId: context.thread.id,
          projectId: context.project.id,
          branchName: context.suggestedBranchName,
          projectSourcePath: location.path,
          repos: provisioned.repos,
          createdAt: Date.now(),
        };
        saveManifest(manifest);
        changed();

        const failed = provisioned.repos.filter((repo) => repo.status === "failed");
        for (const repo of failed) context.report.log(`${repo.dir}: ${repo.message ?? "failed to clone"}`);
        if (failed.length === provisioned.repos.length) {
          return {
            status: "failed",
            message: `No repo could be checked out. ${failed[0]?.message ?? ""}`.trim(),
          };
        }
        context.report.step(`Ready — ${provisioned.repos.length - failed.length} repo(s) checked out`);

        return {
          status: "created",
          path: provisioned.root,
          ownsPath: true,
          // Deliberately no `mergeBaseBranch`: it is a single value on a
          // flattened environment row, and this workspace has one merge base
          // per repo. Publishing one repo's base as if it spoke for all of
          // them would be worse than publishing none — the diff layer
          // computes merge bases per repo instead.
          resource: {
            version: 1,
            root: provisioned.root,
            repos: provisioned.repos.map((repo) => ({
              dir: repo.dir,
              branch: repo.branch,
              status: repo.status,
            })),
          },
        };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { status: "failed", message: errorMessage(error) };
      } finally {
        reports.delete(operationId);
      }
    },

    async remove(context) {
      if (context.hostId === null) {
        return { status: "failed", message: "The workspace machine is unknown." };
      }
      const operationId = `remove#${context.pathKey}#${context.attempt}`;
      reports.set(operationId, context.report);
      try {
        await host.call(
          "removeWorkspace",
          { operationId, pathKey: context.pathKey, path: context.path },
          { hostId: context.hostId, signal: context.signal, timeoutMs: REMOVE_TIMEOUT_MS },
        );
        forgetWorkspace(context.hostId, context.pathKey);
        changed();
        return { status: "removed" };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { status: "failed", message: errorMessage(error) };
      } finally {
        reports.delete(operationId);
      }
    },
  });

  /**
   * The root `create()` will use, for the pre-write claim.
   *
   * Derived from a manifest this plugin already wrote for the same key when
   * there is one. On a first launch there is nothing to derive it from without
   * asking the host where its data directory is, and the claim is then made
   * against the root the host reports after provisioning — which is why a null
   * here is not an error.
   */
  async function plannedRoot(hostId: string, pathKey: string): Promise<string | null> {
    const row = db
      .prepare(`SELECT root FROM workspaces WHERE host_id = ? AND path_key = ?`)
      .get(hostId, pathKey) as { root?: unknown } | undefined;
    return typeof row?.root === "string" ? row.root : null;
  }

  function toRepoRequest(repo: { dir: string; url: string; branch?: string }): RepoRequest {
    return { dir: repo.dir, url: repo.url, branch: repo.branch ?? null };
  }

  /**
   * Turn discovered checkouts into a starting repo set.
   *
   * Only ever used when `repos.json` holds nothing: the alternative is handing
   * someone an empty directory and no explanation. Deduplicated by remote and
   * capped, because a machine with forty checkouts should not produce a forty
   * repo workspace by accident.
   */
  function proposeRepoSet(mirrors: readonly { path: string; url: string }[]): ReposFile {
    const seen = new Set<string>();
    const repos: ReposFile["repos"] = [];
    for (const mirror of mirrors) {
      if (repos.length >= 8) break;
      const key = normalizeRemoteUrl(mirror.url);
      if (seen.has(key)) continue;
      const dir = dirFromUrl(mirror.url);
      if (dir === null || dir === PROJECT_SOURCE_DIR) continue;
      if (repos.some((repo) => repo.dir === dir)) continue;
      seen.add(key);
      repos.push({ dir, url: mirror.url });
    }
    return { version: 1, repos };
  }

  /* --------------------------------------------------- the agent surface */

  /**
   * The generated facts block.
   *
   * Synchronous and on the thread-start path, so it does no work beyond one
   * indexed row read: `create()` already formatted the text. It is
   * authoritative at thread start and stale only with respect to
   * `workspace_add_repo` — a live provider session keeps the instructions it
   * was constructed with, never mid-session — which is precisely why that tool
   * returns the new repo's location in its own result text.
   */
  bb.agents.contributeInstructions(({ threadId }) => {
    if (threadId === null || threadId === undefined) return null;
    return instructionsForThread(threadId);
  });

  /** The workspace a tool call is running inside, or a thrown explanation. */
  function requireManifest(threadId: string | null | undefined): WorkspaceManifest {
    const manifest = threadId === null || threadId === undefined ? null : manifestForThread(threadId);
    if (manifest === null) {
      throw new Error(
        "This thread does not have a multi-repo workspace. Its environment was created by a different provider.",
      );
    }
    return manifest;
  }

  bb.agents.registerTool({
    name: "workspace_list_repos",
    description:
      "List the repos in this thread's multi-repo workspace, with each one's directory, branch, and absolute path.",
    instructions:
      "Use workspace_list_repos when you need a repo's absolute path or branch and the workspace layout block is not enough.",
    presentation: { label: { pending: "Listing workspace repos", completed: "Listed workspace repos" } },
    parameters: z.object({}),
    async execute(_input, { threadId }) {
      const manifest = requireManifest(threadId);
      const lines = manifest.repos.map(describeRepo);
      return [`dir\tbranch\tpath`, ...lines].join("\n");
    },
  });

  bb.agents.registerTool({
    name: "workspace_add_repo",
    description:
      "Add a git repo to this project's repo set and clone it into the live workspace, without restarting the thread.",
    instructions:
      "workspace_add_repo edits the project's shared repos.json, so it affects every future thread in this project. Use it when work genuinely spans another repo, not to fetch something for a one-off look.",
    presentation: { label: { pending: "Adding a repo to the workspace", completed: "Added a repo to the workspace" } },
    parameters: z.object({
      url: z.string().min(1).max(2000).describe("Anything git can clone, including an absolute local path."),
      dir: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe("Directory name inside the workspace. Defaults to the repo's name."),
      branch: z.string().min(1).max(300).optional().describe("Base branch. Defaults to the repo's default branch."),
    }),
    async execute(input, { threadId, signal }) {
      const manifest = requireManifest(threadId);
      const location: SourceLocation = { hostId: manifest.hostId, path: manifest.projectSourcePath };
      const current = await readRepoSet(location, { bootstrap: true }, signal);
      if (current.file === null) throw new Error(current.error ?? `${REPOS_FILE} could not be read.`);

      const dir = input.dir ?? dirFromUrl(input.url);
      if (dir === null) {
        throw new Error(`Could not derive a directory name from ${input.url}. Pass an explicit "dir".`);
      }
      const clash = findRepo(current.file, { dir, url: input.url });
      if (clash !== null) {
        throw new Error(`${clash.dir} is already in the repo set (${clash.url}).`);
      }

      const entry = { dir, url: input.url, ...(input.branch === undefined ? {} : { branch: input.branch }) };
      const edited = addRepo(current.file, entry);
      if (!edited.ok) throw new Error(edited.error);

      // All three writes run host-side: the commit in the canonical checkout,
      // the cache population, and the clone into the live workspace. That is
      // what makes this work while the agent is sandboxed.
      await writeRepoSet(location, edited.value, `Add ${dir} to the repo set`, signal);

      const added = await host.call(
        "addWorkspaceRepo",
        {
          operationId: `add#${manifest.pathKey}#${dir}#${Date.now()}`,
          pathKey: manifest.pathKey,
          root: manifest.root,
          repo: toRepoRequest(entry),
          branchName: manifest.branchName,
          fetchTtlMs: CACHE_FRESH_MS,
          mirrors: await localCheckouts(manifest.hostId, manifest.projectSourcePath, signal),
        },
        { hostId: manifest.hostId, timeoutMs: CREATE_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
      );

      saveManifest({ ...manifest, repos: [...manifest.repos.filter((r) => r.dir !== dir), added.repo] });
      changed();

      if (added.repo.status === "failed") {
        throw new Error(
          `${dir} was added to ${REPOS_FILE} but could not be cloned: ${added.repo.message ?? "unknown error"}`,
        );
      }
      // The result text carries the facts rather than pointing at the layout
      // block: that block was built at thread start and this session will
      // never see a new version of it.
      return [
        `Added ${dir}.`,
        `path: ${added.repo.path}`,
        `branch: ${added.repo.branch} (based on ${added.repo.baseBranch})`,
        `remote: ${added.repo.remote}`,
      ].join("\n");
    },
  });

  bb.agents.registerTool({
    name: "workspace_remove_repo",
    description:
      "Remove a repo from this project's repo set. Existing workspaces keep their checkout; future threads will not get it.",
    presentation: { label: { pending: "Removing a repo from the repo set", completed: "Removed a repo from the repo set" } },
    parameters: z.object({ dir: z.string().min(1).max(100) }),
    async execute(input, { threadId, signal }) {
      const manifest = requireManifest(threadId);
      const location: SourceLocation = { hostId: manifest.hostId, path: manifest.projectSourcePath };
      const current = await readRepoSet(location, { bootstrap: true }, signal);
      if (current.file === null) throw new Error(current.error ?? `${REPOS_FILE} could not be read.`);
      const edited = removeRepo(current.file, input.dir);
      if (!edited.ok) throw new Error(edited.error);
      await writeRepoSet(location, edited.value, `Remove ${input.dir} from the repo set`, signal);
      // Deliberately leaves the checkout alone. A workspace should not mutate
      // under a running thread, and deleting a directory the agent may have
      // uncommitted work in would be the worst possible way to learn that.
      return `Removed ${input.dir} from ${REPOS_FILE}. The existing checkout at ${manifest.root}/${input.dir} is untouched.`;
    },
  });

  bb.agents.registerTool({
    name: "workspace_publish_guidance",
    description:
      "Publish commits made in this workspace's .bb directory (AGENTS.md, skills, repos.json) back to the project's canonical checkout, as a branch to review and merge.",
    instructions:
      "Commit inside .bb first, then call workspace_publish_guidance. The canonical checkout is outside your sandbox, so a plain git push will not reach it.",
    presentation: { label: { pending: "Publishing workspace guidance", completed: "Published workspace guidance" } },
    parameters: z.object({}),
    async execute(_input, { threadId, signal }) {
      const manifest = requireManifest(threadId);
      const source = manifest.repos.find((repo) => repo.dir === PROJECT_SOURCE_DIR);
      if (source === undefined || source.status !== "ready") {
        throw new Error("This workspace has no .bb checkout to publish from.");
      }
      const result = await host.call(
        "pushGuidance",
        {
          projectSourcePath: manifest.projectSourcePath,
          workspaceBbPath: source.path,
          threadId: manifest.threadId,
        },
        { hostId: manifest.hostId, timeoutMs: ACTION_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
      );
      if (!result.ok) throw new Error(result.message);
      changed();
      return result.message;
    },
  });

  /* ------------------------------------------------------------ the CLI */

  /**
   * `bb repos`.
   *
   * Worth having because there is no project-settings slot among the plugin
   * app slots, so the repo list lives in a plugin nav panel rather than beside
   * bb's own project settings. Someone looking in the obvious place will not
   * find it; this is the answer for them and for an agent that would rather
   * run a command than open a panel.
   */
  async function resolveProjectId(ctx: { projectId?: string | null; threadId?: string | null }): Promise<string> {
    if (typeof ctx.projectId === "string" && ctx.projectId.length > 0) return ctx.projectId;
    if (typeof ctx.threadId === "string" && ctx.threadId.length > 0) {
      const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
      if (thread.projectId.length > 0) return thread.projectId;
    }
    throw new PluginCliError("No project in context.", {
      code: "project_required",
      hint: "Run this inside a project thread, or from a directory bb associates with a project.",
    });
  }

  async function requireSource(projectId: string): Promise<SourceLocation> {
    const location = await projectSource(projectId);
    if (location === null) {
      throw new PluginCliError("This project has no checkout on any machine.", {
        code: "no_project_source",
        hint: "Add a project source in bb's project settings first.",
      });
    }
    return location;
  }

  bb.cli.register(
    defineCli({
      name: "repos",
      summary: "The multi-repo workspace's repo set",
      commands: {
        list: cliCommand({
          summary: "List the project's repo set and the state of each one's object cache",
          options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
          async run(input, ctx) {
            const location = await requireSource(await resolveProjectId(ctx));
            const set = await readRepoSet(location, { bootstrap: false }, ctx.signal);
            if (set.file === null) {
              throw new PluginCliError(set.error ?? `${REPOS_FILE} could not be read.`, {
                code: "invalid_repos_json",
                hint: `Fix ${REPOS_FILE} in ${location.path}.`,
              });
            }
            const cache = await host.call(
              "cacheStatus",
              { repos: set.file.repos.map((repo) => ({ url: repo.url })) },
              { hostId: location.hostId, timeoutMs: READ_TIMEOUT_MS, signal: ctx.signal },
            );
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ source: location, repos: set.file.repos, cache: cache.entries }, null, 2),
              };
            }
            if (set.file.repos.length === 0) {
              return { exitCode: 0, stdout: `No repos configured in ${location.path}/${REPOS_FILE}.` };
            }
            const byUrl = new Map(cache.entries.map((entry) => [entry.url, entry]));
            const lines = set.file.repos.map((repo) => {
              const entry = byUrl.get(repo.url);
              const state = entry === undefined || !entry.present ? "not cached" : describeCacheEntry(entry);
              return `${repo.dir}\t${repo.branch ?? "(default)"}\t${repo.url}\t${state}`;
            });
            return { exitCode: 0, stdout: ["dir\tbranch\turl\tcache", ...lines].join("\n") };
          },
        }),

        add: cliCommand({
          summary: "Add a repo to the project's repo set",
          positionals: [{ name: "url", description: "Anything git can clone, including a local path", required: true }],
          options: {
            dir: { type: "string", description: "Directory name inside each workspace (default: the repo's name)" },
            branch: { type: "string", description: "Base branch (default: the repo's default branch)" },
          },
          async run(input, ctx) {
            const location = await requireSource(await resolveProjectId(ctx));
            const set = await readRepoSet(location, { bootstrap: true }, ctx.signal);
            if (set.file === null) {
              throw new PluginCliError(set.error ?? `${REPOS_FILE} could not be read.`, { code: "invalid_repos_json" });
            }
            const url = input.positionals.url;
            const dir = input.options.dir ?? dirFromUrl(url);
            if (dir === null) {
              throw new PluginCliError(`Could not derive a directory name from ${url}.`, {
                code: "dir_required",
                hint: "Pass --dir <name>.",
              });
            }
            const edited = addRepo(set.file, {
              dir,
              url,
              ...(input.options.branch === undefined ? {} : { branch: input.options.branch }),
            });
            if (!edited.ok) throw new PluginCliError(edited.error, { code: "invalid_repo_set" });
            await writeRepoSet(location, edited.value, `Add ${dir} to the repo set`, ctx.signal);
            return {
              exitCode: 0,
              stdout: `Added ${dir}. New threads in this project will get it; existing workspaces are unchanged.`,
            };
          },
        }),

        remove: cliCommand({
          summary: "Remove a repo from the project's repo set",
          positionals: [{ name: "dir", description: "The directory name in the repo set", required: true }],
          async run(input, ctx) {
            const location = await requireSource(await resolveProjectId(ctx));
            const set = await readRepoSet(location, { bootstrap: false }, ctx.signal);
            if (set.file === null) {
              throw new PluginCliError(set.error ?? `${REPOS_FILE} could not be read.`, { code: "invalid_repos_json" });
            }
            const edited = removeRepo(set.file, input.positionals.dir);
            if (!edited.ok) throw new PluginCliError(edited.error, { code: "unknown_repo" });
            await writeRepoSet(location, edited.value, `Remove ${input.positionals.dir} from the repo set`, ctx.signal);
            return { exitCode: 0, stdout: `Removed ${input.positionals.dir}. Existing workspaces are unchanged.` };
          },
        }),

        status: cliCommand({
          summary: "Show this thread's workspace: each repo's branch and working-tree state",
          async run(_input, ctx) {
            if (typeof ctx.threadId !== "string" || ctx.threadId.length === 0) {
              throw new PluginCliError("No thread in context.", {
                code: "thread_required",
                hint: "Run `bb repos status` from inside a thread.",
              });
            }
            const manifest = manifestForThread(ctx.threadId);
            if (manifest === null) {
              return { exitCode: 0, stdout: "This thread does not have a multi-repo workspace." };
            }
            const live = await host.call(
              "workspaceStatus",
              { repos: manifest.repos.filter((r) => r.status === "ready").map(toTarget) },
              { hostId: manifest.hostId, timeoutMs: READ_TIMEOUT_MS, signal: ctx.signal },
            );
            const lines = live.repos.map(
              (repo) =>
                `${repo.dir}\t${repo.branch ?? "-"}\t+${repo.ahead}/-${repo.behind}\t${repo.dirty} changed, ${repo.untracked} untracked${repo.error === null ? "" : `\t${repo.error}`}`,
            );
            return {
              exitCode: 0,
              stdout: [`${manifest.root} (branch ${manifest.branchName})`, "", "dir\tbranch\tahead/behind\tworking tree", ...lines].join("\n"),
            };
          },
        }),
      },
    }),
  );

  function describeCacheEntry(entry: CacheEntry): string {
    const age = entry.fetchedAt === null ? "never fetched" : `fetched ${relativeTime(entry.fetchedAt)}`;
    const size = entry.sizeBytes === null ? "" : `, ${(entry.sizeBytes / 1024 / 1024).toFixed(1)} MB`;
    return `${age}${size}`;
  }

  function relativeTime(at: number): string {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 90) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
  }

  function toTarget(repo: WorkspaceRepo): RepoTarget {
    return { dir: repo.dir, path: repo.path, baseBranch: repo.baseBranch };
  }

  /* ------------------------------------------------------------ the RPC */

  bb.rpc.register(rpcContract, {
    async repoSet({ projectId }) {
      const location = await projectSource(projectId);
      if (location === null) {
        return { projectSourcePath: null, hostId: null, reposJson: null, repos: [], error: null, cache: [] };
      }
      try {
        const set = await readRepoSet(location, { bootstrap: false });
        const repos =
          set.file === null
            ? []
            : set.file.repos.map((repo) => ({ dir: repo.dir, url: repo.url, branch: repo.branch ?? null }));
        const cache =
          set.file === null
            ? []
            : (
                await host.call(
                  "cacheStatus",
                  { repos: set.file.repos.map((repo) => ({ url: repo.url })) },
                  { hostId: location.hostId, timeoutMs: READ_TIMEOUT_MS },
                )
              ).entries;
        return {
          projectSourcePath: location.path,
          hostId: location.hostId,
          reposJson: set.text,
          repos,
          error: set.error,
          cache,
        };
      } catch (error) {
        return {
          projectSourcePath: location.path,
          hostId: location.hostId,
          reposJson: null,
          repos: [],
          error: errorMessage(error),
          cache: [],
        };
      }
    },

    async saveRepoSet({ projectId, reposJson }) {
      const location = await projectSource(projectId);
      if (location === null) return { ok: false, error: "This project has no checkout on any machine." };
      // Validated here as well as in the panel: the panel's copy of the rules
      // is a convenience, and this is the boundary.
      const parsed = parseReposFile(reposJson);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      try {
        await writeRepoSet(location, parsed.value, `Update the repo set`);
        return { ok: true, error: null };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },

    workspace({ threadId }) {
      const manifest = manifestForThread(threadId);
      if (manifest === null) return { workspace: null };
      return {
        workspace: {
          root: manifest.root,
          branchName: manifest.branchName,
          hostId: manifest.hostId,
          projectSourcePath: manifest.projectSourcePath,
          repos: manifest.repos,
        },
      };
    },

    async workspaceStatus({ threadId }) {
      const manifest = manifestForThread(threadId);
      if (manifest === null) return { repos: [] };
      const result = await host.call(
        "workspaceStatus",
        { repos: readyRepos(manifest).map(toTarget) },
        { hostId: manifest.hostId, timeoutMs: READ_TIMEOUT_MS },
      );
      return { repos: result.repos };
    },

    async changes({ threadId }) {
      const manifest = manifestForThread(threadId);
      if (manifest === null) return { repos: [] };
      const result = await host.call(
        "diffSummary",
        { repos: readyRepos(manifest).map(toTarget), maxFiles: MAX_DIFF_FILES },
        { hostId: manifest.hostId, timeoutMs: READ_TIMEOUT_MS },
      );
      return { repos: result.repos };
    },

    async filePatch({ threadId, dir, file, untracked }) {
      const manifest = manifestForThread(threadId);
      const repo = manifest?.repos.find((entry) => entry.dir === dir);
      if (manifest === null || repo === undefined) {
        return { patch: "", truncated: false, error: "That repo is not in this workspace." };
      }
      return host.call(
        "diffFile",
        {
          repoPath: repo.path,
          baseBranch: repo.baseBranch,
          file,
          untracked,
          maxBytes: MAX_PATCH_BYTES,
        },
        { hostId: manifest.hostId, timeoutMs: READ_TIMEOUT_MS },
      );
    },

    async pullRequests({ threadId, refresh }) {
      const manifest = manifestForThread(threadId);
      if (manifest === null) return { repos: [], fetchedAt: null };
      const work = readyRepos(manifest).filter((repo) => repo.dir !== PROJECT_SOURCE_DIR);

      if (!refresh) {
        const cached = readPrCache(threadId, work.map((repo) => repo.dir));
        if (cached !== null) return cached;
      }
      const result = await host.call(
        "pullRequests",
        { repos: work.map((repo) => ({ dir: repo.dir, path: repo.path })), branch: manifest.branchName },
        { hostId: manifest.hostId, timeoutMs: READ_TIMEOUT_MS },
      );
      const fetchedAt = Date.now();
      writePrCache(threadId, result.repos, fetchedAt);
      return { repos: result.repos, fetchedAt };
    },

    async pullRequestAction({ threadId, dir, action }) {
      const manifest = manifestForThread(threadId);
      const repo = manifest?.repos.find((entry) => entry.dir === dir);
      if (manifest === null || repo === undefined) {
        return { ok: false, message: "That repo is not in this workspace.", url: null };
      }
      const full =
        action.kind === "create"
          ? { ...action, base: repo.baseBranch }
          : action;
      const result = await host.call(
        "pullRequestAction",
        { repoPath: repo.path, branch: repo.branch, action: full },
        { hostId: manifest.hostId, timeoutMs: ACTION_TIMEOUT_MS },
      );
      // Any write invalidates the read, whether or not it succeeded: a failed
      // merge still may have changed the PR's mergeability.
      db.prepare(`DELETE FROM pr_cache WHERE thread_id = ? AND dir = ?`).run(threadId, dir);
      changed();
      return result;
    },
  });

  /** All of a thread's cached PR rows, or null when any is missing or stale. */
  function readPrCache(
    threadId: string,
    dirs: readonly string[],
  ): { repos: RepoPullRequest[]; fetchedAt: number } | null {
    if (dirs.length === 0) return { repos: [], fetchedAt: Date.now() };
    const rows = db
      .prepare(`SELECT dir, payload, fetched_at FROM pr_cache WHERE thread_id = ?`)
      .all(threadId) as { dir: string; payload: string; fetched_at: number }[];
    const byDir = new Map(rows.map((row) => [row.dir, row]));
    const cutoff = Date.now() - PR_CACHE_TTL_MS;
    const repos: RepoPullRequest[] = [];
    let oldest = Number.POSITIVE_INFINITY;
    for (const dir of dirs) {
      const row = byDir.get(dir);
      if (row === undefined || row.fetched_at < cutoff) return null;
      try {
        repos.push(JSON.parse(row.payload) as RepoPullRequest);
      } catch {
        return null;
      }
      oldest = Math.min(oldest, row.fetched_at);
    }
    return { repos, fetchedAt: oldest };
  }

  function writePrCache(threadId: string, repos: readonly RepoPullRequest[], fetchedAt: number): void {
    const statement = db.prepare(
      `INSERT INTO pr_cache (thread_id, dir, payload, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (thread_id, dir) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
    );
    for (const repo of repos) statement.run(threadId, repo.dir, JSON.stringify(repo), fetchedAt);
  }

  /* ---------------------------------------------------- background sweep */

  /**
   * Keep the object cache warm, so a cold start is rare rather than routine.
   *
   * Fetching synchronously on every thread start would put a network round
   * trip per repo between pressing New thread and getting a workspace. This
   * does the same work off the critical path, per machine, and only for
   * entries that already exist — cloning a repo nobody has opened yet would
   * pay a cold start on a machine that may never need it.
   */
  bb.background.schedule("refresh-caches", "17 * * * *", async () => {
    const rows = db.prepare(`SELECT DISTINCT host_id, repos FROM workspaces`).all() as {
      host_id: string;
      repos: string;
    }[];
    const byHost = new Map<string, Set<string>>();
    for (const row of rows) {
      let repos: WorkspaceRepo[];
      try {
        repos = JSON.parse(row.repos) as WorkspaceRepo[];
      } catch {
        continue;
      }
      const urls = byHost.get(row.host_id) ?? new Set<string>();
      for (const repo of repos) {
        if (repo.dir !== PROJECT_SOURCE_DIR && repo.remote.length > 0) urls.add(repo.remote);
      }
      byHost.set(row.host_id, urls);
    }
    for (const [hostId, urls] of byHost) {
      try {
        await host.call(
          "refreshCaches",
          { repos: [...urls].slice(0, 200).map((url) => ({ url })), maxAgeMs: CACHE_BACKGROUND_MS },
          { hostId, timeoutMs: 30 * 60 * 1000 },
        );
      } catch (error) {
        // A machine that is asleep or offline is the normal case, not a fault.
        bb.log.debug(`Cache refresh skipped for ${hostId}: ${errorMessage(error)}`);
      }
    }
  });

  bb.log.info(`Multi-repo workspaces ready (max ${MAX_REPOS} repos per project).`);
}
