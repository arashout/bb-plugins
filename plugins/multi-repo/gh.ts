/**
 * Pull requests, per repo, through the `gh` CLI.
 *
 * `gh` rather than the GitHub API because it already holds the user's
 * credentials, already knows which host a repo belongs to (including
 * Enterprise), and is what the person would run by hand. The cost is that it
 * may be missing or unauthenticated, which is reported per repo rather than
 * treated as a failure of the panel.
 *
 * Every repo is asked independently: a workspace can span two GitHub orgs, a
 * GitHub Enterprise host, and a repo with no remote worth asking about at all.
 */
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PullRequest, RepoPullRequest } from "./contract.js";
import { firstProblemLine, gitIn, run } from "./git.js";
import { PR_FIELDS, parseCreatedUrl, parsePrList } from "./gh-parse.js";

const GH_READ_TIMEOUT_MS = 30_000;
const GH_WRITE_TIMEOUT_MS = 120_000;
const PUSH_TIMEOUT_MS = 10 * 60 * 1000;

/** How many repos are asked at once. `gh` is a network call per repo. */
const CONCURRENCY = 4;

async function gh(
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; stdout: string; error: string }> {
  try {
    const result = await run("gh", args, {
      cwd,
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.code !== 0) return { ok: false, stdout: result.stdout, error: firstProblemLine(result) };
    return { ok: true, stdout: result.stdout, error: "" };
  } catch (error) {
    // ENOENT for a machine with no `gh`. Say so plainly — it is the single
    // most common reason this panel has nothing to show, and "spawn gh
    // ENOENT" tells the reader nothing about what to install.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, stdout: "", error: "The gh CLI is not installed on this machine." };
    return { ok: false, stdout: "", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Run `work` over `items` with a bounded number in flight. */
async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function readPullRequest(
  repoPath: string,
  branch: string,
  signal?: AbortSignal,
): Promise<{ pr: PullRequest | null; error: string | null }> {
  const result = await gh(
    ["pr", "list", "--head", branch, "--state", "all", "--limit", "5", "--json", PR_FIELDS],
    repoPath,
    GH_READ_TIMEOUT_MS,
    signal,
  );
  if (!result.ok) {
    // A repo with no GitHub remote is not an error worth a red banner; it just
    // has no pull requests. `gh` says so in a recognizable way.
    if (/none of the git remotes|not a git repository|no git remotes/iu.test(result.error)) {
      return { pr: null, error: null };
    }
    return { pr: null, error: result.error };
  }
  return { pr: parsePrList(result.stdout), error: null };
}

export async function readPullRequests(
  repos: readonly { dir: string; path: string }[],
  branch: string,
  signal?: AbortSignal,
): Promise<RepoPullRequest[]> {
  return mapLimit(repos, CONCURRENCY, async (repo) => {
    const { pr, error } = await readPullRequest(repo.path, branch, signal);
    return { dir: repo.dir, pr, error };
  });
}

export type PrAction =
  | { kind: "create"; title: string; body: string; base: string; draft: boolean }
  | { kind: "ready" }
  | { kind: "merge"; method: "merge" | "squash" | "rebase" }
  | { kind: "push" };

export interface ActionResult {
  ok: boolean;
  message: string;
  url: string | null;
}

/**
 * Push the current branch, setting upstream the first time.
 *
 * `--force-with-lease` is deliberately *not* used: this pushes an agent's work
 * to a shared remote, and a failed non-fast-forward push is a conflict a
 * person should look at rather than something a panel button resolves.
 */
export async function pushBranch(
  repoPath: string,
  branch: string,
  signal?: AbortSignal,
): Promise<ActionResult> {
  const result = await gitIn(repoPath, ["push", "--set-upstream", "origin", `${branch}:${branch}`], {
    timeoutMs: PUSH_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  });
  return result.code === 0
    ? { ok: true, message: `Pushed ${branch}.`, url: null }
    : { ok: false, message: firstProblemLine(result), url: null };
}

export async function runPrAction(args: {
  repoPath: string;
  branch: string;
  action: PrAction;
  tempDir: string;
  signal?: AbortSignal;
}): Promise<ActionResult> {
  const { repoPath, branch, action, signal } = args;

  if (action.kind === "push") return pushBranch(repoPath, branch, signal);

  if (action.kind === "create") {
    // A PR needs the branch on the remote, and an agent that has only
    // committed locally is the normal state when someone opens this panel.
    const pushed = await pushBranch(repoPath, branch, signal);
    if (!pushed.ok) return pushed;
    // `--body-file` rather than `--body`: the spawn helper gives no stdin, and
    // a long body on the argument list risks the platform's argument limit.
    const bodyPath = path.join(args.tempDir, `pr-body-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    await writeFile(bodyPath, action.body, "utf8");
    try {
      const result = await gh(
        [
          "pr",
          "create",
          "--head",
          branch,
          "--base",
          action.base,
          "--title",
          action.title,
          "--body-file",
          bodyPath,
          ...(action.draft ? ["--draft"] : []),
        ],
        repoPath,
        GH_WRITE_TIMEOUT_MS,
        signal,
      );
      if (!result.ok) return { ok: false, message: result.error, url: null };
      const url = parseCreatedUrl(result.stdout);
      return { ok: true, message: url ?? "Pull request created.", url };
    } finally {
      await unlink(bodyPath).catch(() => undefined);
    }
  }

  if (action.kind === "ready") {
    const result = await gh(["pr", "ready", branch], repoPath, GH_WRITE_TIMEOUT_MS, signal);
    return result.ok
      ? { ok: true, message: "Marked ready for review.", url: null }
      : { ok: false, message: result.error, url: null };
  }

  const flag = action.method === "squash" ? "--squash" : action.method === "rebase" ? "--rebase" : "--merge";
  const result = await gh(["pr", "merge", branch, flag], repoPath, GH_WRITE_TIMEOUT_MS, signal);
  return result.ok
    ? { ok: true, message: `Merged (${action.method}).`, url: null }
    : { ok: false, message: result.error, url: null };
}
