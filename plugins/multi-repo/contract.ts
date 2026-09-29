/**
 * The two RPC contracts: server ↔ host, and frontend ↔ server.
 *
 * Both sides of each import this module, so these schemas are the single
 * definition of what crosses the boundary. The host runs on the machine that
 * holds the repos and owns every filesystem and git operation; the server owns
 * storage, the provider registration and the agent surface; the app owns the
 * panels. Nothing is inferred across a boundary — a host method that operates
 * on a directory takes the absolute path in its input, because core does not
 * infer an environment or a cwd for host RPC.
 */
import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";

const absolutePath = z.string().min(1).max(4096);

export const repoStatusSchema = z.enum(["ready", "failed"]);

export const workspaceRepoSchema = z
  .object({
    dir: z.string().min(1).max(100),
    path: absolutePath,
    // Empty is legal on both: a repo that failed to materialize has no branch
    // and no base. Requiring a name here would make the failure path throw at
    // the RPC boundary instead of being reported, which is the opposite of
    // the per-repo failure policy.
    branch: z.string().max(300),
    baseBranch: z.string().max(300),
    remote: z.string().max(2000),
    status: repoStatusSchema,
    message: z.string().max(600).optional(),
  })
  .strict();

/** One repo as `provisionWorkspace` is asked to materialize it. */
export const repoRequestSchema = z
  .object({
    dir: z.string().min(1).max(100),
    url: z.string().min(1).max(2000),
    branch: z.string().min(1).max(300).nullable(),
  })
  .strict();

export type RepoRequest = z.infer<typeof repoRequestSchema>;

/** A repo the panel or the diff layer already knows the location of. */
export const repoTargetSchema = z
  .object({
    dir: z.string().min(1).max(100),
    path: absolutePath,
    baseBranch: z.string().min(1).max(300),
  })
  .strict();

export type RepoTarget = z.infer<typeof repoTargetSchema>;

export const repoLiveStatusSchema = z
  .object({
    dir: z.string().min(1).max(100),
    /** Null when the directory is gone or is not a git repo. */
    branch: z.string().max(300).nullable(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    /** Tracked files with uncommitted changes, staged or not. */
    dirty: z.number().int().nonnegative(),
    untracked: z.number().int().nonnegative(),
    error: z.string().max(600).nullable(),
  })
  .strict();

export type RepoLiveStatus = z.infer<typeof repoLiveStatusSchema>;

export const changeStatusSchema = z.enum(["added", "modified", "deleted", "renamed", "untracked"]);

export const changedFileSchema = z
  .object({
    path: z.string().min(1).max(4096),
    status: changeStatusSchema,
    /** The pre-rename path, when git reported a rename. */
    oldPath: z.string().max(4096).nullable(),
    /** Null for a binary file, which has no line counts. */
    additions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type ChangedFile = z.infer<typeof changedFileSchema>;

export const repoChangesSchema = z
  .object({
    dir: z.string().min(1).max(100),
    baseBranch: z.string().max(300),
    /** The merge base the files below are measured against; null when unknown. */
    mergeBase: z.string().max(64).nullable(),
    files: z.array(changedFileSchema).max(2000),
    /** True when the repo has more changed files than the cap returned. */
    truncated: z.boolean(),
    error: z.string().max(600).nullable(),
  })
  .strict();

export type RepoChanges = z.infer<typeof repoChangesSchema>;

export const pullRequestSchema = z
  .object({
    number: z.number().int(),
    title: z.string().max(400),
    url: z.string().max(600),
    state: z.string().max(40),
    isDraft: z.boolean(),
    baseRefName: z.string().max(300),
    headRefName: z.string().max(300),
    /** `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or null. */
    reviewDecision: z.string().max(40).nullable(),
    /** `CLEAN`, `BEHIND`, `DIRTY`, `BLOCKED`, `UNSTABLE`, `HAS_HOOKS`, `UNKNOWN`. */
    mergeStateStatus: z.string().max(40),
    mergeable: z.string().max(40).nullable(),
    /** Every `statusCheckRollup` conclusion, uppercased. */
    checks: z
      .array(z.object({ name: z.string().max(200), conclusion: z.string().max(40).nullable() }).strict())
      .max(100),
    reviewRequestCount: z.number().int().nonnegative(),
  })
  .strict();

export type PullRequest = z.infer<typeof pullRequestSchema>;

export const repoPullRequestSchema = z
  .object({
    dir: z.string().min(1).max(100),
    /** Null when the branch has no PR, or when `gh` could not answer. */
    pr: pullRequestSchema.nullable(),
    error: z.string().max(600).nullable(),
  })
  .strict();

export type RepoPullRequest = z.infer<typeof repoPullRequestSchema>;

export const cacheEntrySchema = z
  .object({
    key: z.string().max(200),
    url: z.string().max(2000),
    present: z.boolean(),
    /** Epoch ms of the last successful fetch, or null if never fetched. */
    fetchedAt: z.number().int().nullable(),
    sizeBytes: z.number().int().nonnegative().nullable(),
    error: z.string().max(600).nullable(),
  })
  .strict();

export type CacheEntry = z.infer<typeof cacheEntrySchema>;

export const discoveredCheckoutSchema = z
  .object({ path: absolutePath, url: z.string().min(1).max(2000) })
  .strict();

export type DiscoveredCheckout = z.infer<typeof discoveredCheckoutSchema>;

/* ------------------------------------------------------------------ host */

export const hostContract = defineRpcContract({
  /**
   * Make the canonical `.bb` checkout usable: initialize it when the directory
   * has no `.git`, fetch it when it has a remote and its last fetch is older
   * than the TTL, then read `repos.json`.
   *
   * One call rather than three because all three touch the same directory and
   * the middle one is conditional on the first.
   */
  prepareProjectSource: {
    input: z
      .object({
        path: absolutePath,
        fetchTtlMs: z.number().int().nonnegative(),
        /**
         * Whether an absent `.git` should be initialized.
         *
         * True only on the provisioning path. Merely opening the Repos panel
         * or running `bb repos list` must not `git init` someone's directory
         * as a side effect of a read.
         */
        bootstrap: z.boolean(),
      })
      .strict(),
    output: z
      .object({
        bootstrapped: z.boolean(),
        /** The file's text, or null when the repo has no `repos.json` yet. */
        reposJson: z.string().max(200_000).nullable(),
        remote: z.string().max(2000).nullable(),
        defaultBranch: z.string().max(300).nullable(),
        warnings: z.array(z.string().max(600)).max(20),
      })
      .strict(),
  },

  /** Write `repos.json` in the canonical checkout and commit it. */
  writeProjectSourceRepos: {
    input: z
      .object({
        path: absolutePath,
        reposJson: z.string().max(200_000),
        message: z.string().min(1).max(300),
      })
      .strict(),
    output: z
      .object({
        committed: z.boolean(),
        head: z.string().max(64).nullable(),
        /** Why the commit did not happen, when it did not. */
        message: z.string().max(600).nullable(),
      })
      .strict(),
  },

  /**
   * Read the `origin` of each candidate directory, and of the immediate
   * children of each search root. Used both to find a local mirror to seed the
   * object cache from and to propose a repo set for an empty project.
   */
  discoverCheckouts: {
    input: z
      .object({
        paths: z.array(absolutePath).max(500),
        searchRoots: z.array(absolutePath).max(20),
      })
      .strict(),
    output: z.object({ checkouts: z.array(discoveredCheckoutSchema).max(500) }).strict(),
  },

  /** Clone every repo plus `.bb` into a fresh workspace root. Idempotent per pathKey. */
  provisionWorkspace: {
    input: z
      .object({
        operationId: z.string().min(1).max(200),
        pathKey: z.string().min(1).max(200),
        projectSourcePath: absolutePath,
        repos: z.array(repoRequestSchema).max(64),
        branchName: z.string().min(1).max(300),
        fetchTtlMs: z.number().int().nonnegative(),
        /** Local checkouts this machine already has, for cache seeding. */
        mirrors: z.array(discoveredCheckoutSchema).max(500),
      })
      .strict(),
    output: z
      .object({
        root: absolutePath,
        repos: z.array(workspaceRepoSchema).max(64),
      })
      .strict(),
  },

  /** Clone one more repo into a workspace that is already live. */
  addWorkspaceRepo: {
    input: z
      .object({
        operationId: z.string().min(1).max(200),
        pathKey: z.string().min(1).max(200),
        root: absolutePath,
        repo: repoRequestSchema,
        branchName: z.string().min(1).max(300),
        fetchTtlMs: z.number().int().nonnegative(),
        mirrors: z.array(discoveredCheckoutSchema).max(500),
      })
      .strict(),
    output: z.object({ repo: workspaceRepoSchema }).strict(),
  },

  removeWorkspace: {
    input: z
      .object({
        operationId: z.string().min(1).max(200),
        pathKey: z.string().min(1).max(200),
        path: absolutePath.nullable(),
      })
      .strict(),
    output: z.object({ removed: z.boolean() }).strict(),
  },

  /** Fetch every cache entry older than `maxAgeMs`. The background sweep's call. */
  refreshCaches: {
    input: z
      .object({
        repos: z.array(z.object({ url: z.string().min(1).max(2000) }).strict()).max(200),
        maxAgeMs: z.number().int().nonnegative(),
      })
      .strict(),
    output: z.object({ entries: z.array(cacheEntrySchema).max(200) }).strict(),
  },

  cacheStatus: {
    input: z.object({ repos: z.array(z.object({ url: z.string().min(1).max(2000) }).strict()).max(200) }).strict(),
    output: z.object({ entries: z.array(cacheEntrySchema).max(200) }).strict(),
  },

  workspaceStatus: {
    input: z.object({ repos: z.array(repoTargetSchema).max(64) }).strict(),
    output: z.object({ repos: z.array(repoLiveStatusSchema).max(64) }).strict(),
  },

  diffSummary: {
    input: z
      .object({
        repos: z.array(repoTargetSchema).max(64),
        maxFiles: z.number().int().positive().max(5000),
      })
      .strict(),
    output: z.object({ repos: z.array(repoChangesSchema).max(64) }).strict(),
  },

  diffFile: {
    input: z
      .object({
        repoPath: absolutePath,
        baseBranch: z.string().min(1).max(300),
        file: z.string().min(1).max(4096),
        untracked: z.boolean(),
        maxBytes: z.number().int().positive().max(8 * 1024 * 1024),
      })
      .strict(),
    output: z
      .object({
        patch: z.string().max(8 * 1024 * 1024),
        truncated: z.boolean(),
        error: z.string().max(600).nullable(),
      })
      .strict(),
  },

  pullRequests: {
    input: z
      .object({
        repos: z.array(z.object({ dir: z.string().min(1).max(100), path: absolutePath }).strict()).max(64),
        branch: z.string().min(1).max(300),
      })
      .strict(),
    output: z.object({ repos: z.array(repoPullRequestSchema).max(64) }).strict(),
  },

  pullRequestAction: {
    input: z
      .object({
        repoPath: absolutePath,
        branch: z.string().min(1).max(300),
        action: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("create"),
              title: z.string().min(1).max(300),
              body: z.string().max(60_000),
              base: z.string().min(1).max(300),
              draft: z.boolean(),
            })
            .strict(),
          z.object({ kind: z.literal("ready") }).strict(),
          z
            .object({
              kind: z.literal("merge"),
              method: z.enum(["merge", "squash", "rebase"]),
            })
            .strict(),
          z.object({ kind: z.literal("push") }).strict(),
        ]),
      })
      .strict(),
    output: z
      .object({ ok: z.boolean(), message: z.string().max(2000), url: z.string().max(600).nullable() })
      .strict(),
  },

  /**
   * Publish the workspace's `.bb` commits back to the canonical checkout.
   *
   * Direction is inverted on purpose: the canonical repo is outside the
   * agent's sandbox, so the write is initiated host-side and *pulls* from the
   * workspace. Landing on `refs/heads/guidance-<threadId>` rather than the
   * checked-out branch also sidesteps `receive.denyCurrentBranch`.
   */
  pushGuidance: {
    input: z
      .object({
        projectSourcePath: absolutePath,
        workspaceBbPath: absolutePath,
        threadId: z.string().min(1).max(100),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        ref: z.string().max(300).nullable(),
        message: z.string().max(2000),
      })
      .strict(),
  },
});

export type HostContract = typeof hostContract;

/** Progress from a long host call, relayed into the launch report. */
export const hostSignals = {
  progress: {
    payload: z
      .object({
        operationId: z.string().min(1).max(200),
        kind: z.enum(["step", "log"]),
        text: z.string().min(1).max(2000),
      })
      .strict(),
  },
} satisfies ExperimentalHostSignals;

/* --------------------------------------------------------------- frontend */

export const repoEntryViewSchema = z
  .object({
    dir: z.string().max(100),
    url: z.string().max(2000),
    branch: z.string().max(300).nullable(),
  })
  .strict();

export const repoSetViewSchema = z
  .object({
    /** Null when this project has no `.bb` checkout on a reachable machine. */
    projectSourcePath: absolutePath.nullable(),
    hostId: z.string().max(100).nullable(),
    /** The file's raw text, for the editor. Null when it does not exist yet. */
    reposJson: z.string().max(200_000).nullable(),
    /** Parsed entries, empty when `error` is set. */
    repos: z.array(repoEntryViewSchema).max(64),
    /** The parse or validation failure, verbatim. */
    error: z.string().max(2000).nullable(),
    cache: z.array(cacheEntrySchema).max(200),
  })
  .strict();

export type RepoSetView = z.infer<typeof repoSetViewSchema>;

export const workspaceViewSchema = z
  .object({
    root: absolutePath,
    branchName: z.string().max(300),
    hostId: z.string().max(100),
    projectSourcePath: absolutePath,
    repos: z.array(workspaceRepoSchema).max(64),
  })
  .strict();

export type WorkspaceView = z.infer<typeof workspaceViewSchema>;

export const rpcContract = defineRpcContract({
  /** The repo set for a project, plus per-repo object-cache state. */
  repoSet: {
    input: z.object({ projectId: z.string().min(1).max(100) }).strict(),
    output: repoSetViewSchema,
  },
  saveRepoSet: {
    input: z
      .object({ projectId: z.string().min(1).max(100), reposJson: z.string().max(200_000) })
      .strict(),
    output: z.object({ ok: z.boolean(), error: z.string().max(2000).nullable() }).strict(),
  },
  /** The thread's workspace manifest, or null when the thread has none. */
  workspace: {
    input: z.object({ threadId: z.string().min(1).max(100) }).strict(),
    output: z.object({ workspace: workspaceViewSchema.nullable() }).strict(),
  },
  workspaceStatus: {
    input: z.object({ threadId: z.string().min(1).max(100) }).strict(),
    output: z.object({ repos: z.array(repoLiveStatusSchema).max(64) }).strict(),
  },
  changes: {
    input: z.object({ threadId: z.string().min(1).max(100) }).strict(),
    output: z.object({ repos: z.array(repoChangesSchema).max(64) }).strict(),
  },
  filePatch: {
    input: z
      .object({
        threadId: z.string().min(1).max(100),
        dir: z.string().min(1).max(100),
        file: z.string().min(1).max(4096),
        untracked: z.boolean(),
      })
      .strict(),
    output: z
      .object({
        patch: z.string().max(8 * 1024 * 1024),
        truncated: z.boolean(),
        error: z.string().max(600).nullable(),
      })
      .strict(),
  },
  pullRequests: {
    input: z.object({ threadId: z.string().min(1).max(100), refresh: z.boolean() }).strict(),
    output: z
      .object({
        repos: z.array(repoPullRequestSchema).max(64),
        fetchedAt: z.number().int().nullable(),
      })
      .strict(),
  },
  pullRequestAction: {
    input: z
      .object({
        threadId: z.string().min(1).max(100),
        dir: z.string().min(1).max(100),
        action: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("create"),
              title: z.string().min(1).max(300),
              body: z.string().max(60_000),
              draft: z.boolean(),
            })
            .strict(),
          z.object({ kind: z.literal("ready") }).strict(),
          z.object({ kind: z.literal("merge"), method: z.enum(["merge", "squash", "rebase"]) }).strict(),
          z.object({ kind: z.literal("push") }).strict(),
        ]),
      })
      .strict(),
    output: z
      .object({ ok: z.boolean(), message: z.string().max(2000), url: z.string().max(600).nullable() })
      .strict(),
  },
});

export type RpcContract = typeof rpcContract;
