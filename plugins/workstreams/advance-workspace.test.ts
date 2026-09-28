import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { inspectCheckout, prepareAdvanceWorkspace, type AdvanceGitRunner } from "./advance-workspace.js";
import type { GhRunner } from "./ghactions.js";

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "workstreams-advance-"));
  directories.push(directory);
  const sourcePath = join(directory, "source");
  const git = async (...args: string[]) => (await exec("git", args, { cwd: sourcePath })).stdout.trim();
  await exec("git", ["init", "-b", "main", sourcePath]);
  await git("config", "user.name", "Test User");
  await git("config", "user.email", "test@example.invalid");
  await writeFile(join(sourcePath, "file.txt"), "base\n");
  await git("add", "."); await git("commit", "-m", "Base fixture");
  const base = await git("rev-parse", "HEAD");
  await git("checkout", "-b", "feature");
  await writeFile(join(sourcePath, "file.txt"), "feature\n");
  await git("commit", "-am", "Feature fixture");
  const head = await git("rev-parse", "HEAD");
  await git("update-ref", "refs/pull/42/head", head);
  const remotePath = join(directory, "remote.git");
  await exec("git", ["clone", "--bare", sourcePath, remotePath]);
  await exec("git", ["--git-dir", remotePath, "update-ref", "refs/pull/42/head", head]);
  await git("remote", "add", "origin", "https://github.com/example/widget.git");
  // Keep dirty author work in place; provisioning must never inspect/reset it.
  await writeFile(join(sourcePath, "file.txt"), "uncommitted author work\n");
  const run: AdvanceGitRunner = async (args, cwd) => {
    const actual = [...args];
    if (actual[0] === "fetch") actual[actual.indexOf("origin")] = remotePath;
    try { return { ok: true, stdout: (await exec("git", actual, { cwd })).stdout }; }
    catch (error) { return { ok: false, error: String(error) }; }
  };
  const input = { sourcePath, prUrl: "https://github.com/example/widget/pull/42", expectedHeadOid: head, expectedBaseOid: base, batchId: "batch-1", jobId: "job-42" };
  /** What GitHub reports for the PR; a test moves its head or makes it a draft. */
  const live = { head, isDraft: false };
  const gh: GhRunner = async (args) => {
    const value = args[0] === "api" ? { data: { repository: { pullRequest: {
      headRefOid: live.head, baseRefOid: "c".repeat(40), baseRefName: "main", baseRef: { name: "main", target: { oid: base } }, reviews: { pageInfo: { hasPreviousPage: false }, nodes: [] },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    } } } } : args[1] === "list" ? [] : {
      url: input.prUrl, number: 42, title: "Fix account lookup", state: "OPEN", isDraft: live.isDraft, isCrossRepository: false,
      headRefName: "feature", baseRefName: "main", headRefOid: live.head, baseRefOid: "c".repeat(40),
      reviewDecision: "APPROVED", mergeStateStatus: "BEHIND", mergeable: "MERGEABLE", latestReviews: [], statusCheckRollup: [],
    };
    return { ok: true, stdout: JSON.stringify(value) };
  };
  /** A reviewer follow-up lands on the PR branch: GitHub and the remote report the new head. */
  const advanceHead = async () => {
    await git("commit", "--allow-empty", "-m", "Reviewer follow-up");
    live.head = await git("rev-parse", "HEAD");
    await git("push", "--quiet", remotePath, `${live.head}:refs/pull/42/head`);
    return live.head;
  };
  return { directory, sourcePath, git, head, base, run, gh, input, live, advanceHead, root: join(directory, "workspaces") };
}

describe("isolated advance workspaces", () => {
  it("creates the exact PR checkout using the live base tip despite a stale PR base snapshot, then reuses it", async () => {
    const f = await fixture();
    const first = await prepareAdvanceWorkspace(f.run, f.gh, f.input, f.root);
    expect(first).toMatchObject({ ok: true, created: true });
    if (!first.ok) throw new Error(first.error);
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: first.path })).stdout.trim()).toBe(f.head);
    expect((await exec("git", ["branch", "--show-current"], { cwd: first.path })).stdout.trim()).toBe("");
    expect(first.workerPath).toBe(join(f.root, "batch-1", "example--widget"));
    expect(await readFile(join(f.sourcePath, "file.txt"), "utf8")).toBe("uncommitted author work\n");
    expect(await f.git("branch", "--show-current")).toBe("feature");
    expect(await prepareAdvanceWorkspace(f.run, f.gh, f.input, f.root)).toMatchObject({ ok: true, path: first.path, created: false });
  });

  it("preserves a changed batch checkout instead of silently resetting an interrupted job", async () => {
    const f = await fixture();
    const first = await prepareAdvanceWorkspace(f.run, f.gh, f.input, f.root);
    if (!first.ok) throw new Error(first.error);
    await writeFile(join(first.path, "file.txt"), "unfinished conflict resolution\n");
    expect(await prepareAdvanceWorkspace(f.run, f.gh, f.input, f.root)).toMatchObject({ ok: false, error: expect.stringContaining("preserved") });
    expect(await readFile(join(first.path, "file.txt"), "utf8")).toBe("unfinished conflict resolution\n");
  });

  it("refuses a changed expected commit before creating a worktree", async () => {
    const f = await fixture();
    expect(await prepareAdvanceWorkspace(f.run, f.gh, { ...f.input, expectedHeadOid: "c".repeat(40) }, f.root))
      .toMatchObject({ ok: false, error: expect.stringContaining("changed") });
    expect((await f.git("worktree", "list", "--porcelain")).match(/^worktree /gmu)).toHaveLength(1);
  });

  it("refuses another repository's source or push destination", async () => {
    const f = await fixture();
    await f.git("remote", "set-url", "--push", "origin", "https://github.com/other/widget.git");
    expect(await prepareAdvanceWorkspace(f.run, f.gh, f.input, f.root)).toMatchObject({ ok: false, error: expect.stringContaining("push origin") });
    await f.git("remote", "set-url", "origin", "https://github.com/other/widget.git");
    expect(await prepareAdvanceWorkspace(f.run, f.gh, f.input, f.root)).toMatchObject({ ok: false, error: expect.stringContaining("source origin") });
  });

  it("moves a clean detached checkout behind the PR head to it only when asked, and preserves one holding unpushed commits", async () => {
    const f = await fixture();
    const first = await prepareAdvanceWorkspace(f.run, f.gh, f.input, f.root);
    if (!first.ok) throw new Error(first.error);
    const next = await f.advanceHead();
    const behind = { ...f.input, expectedHeadOid: next, reuseOnly: true };
    const worktreeHead = async () => (await exec("git", ["rev-parse", "HEAD"], { cwd: first.path })).stdout.trim();
    // Legacy callers never ask, so a checkout behind the head stays preserved for them.
    expect(await prepareAdvanceWorkspace(f.run, f.gh, behind, f.root)).toMatchObject({ ok: false, error: expect.stringContaining("preserved") });
    expect(await worktreeHead()).toBe(f.head);
    expect(await prepareAdvanceWorkspace(f.run, f.gh, { ...behind, moveCleanToHead: true }, f.root)).toEqual({ ok: true, path: first.path,
      workerPath: first.workerPath, sourcePath: first.sourcePath, created: false });
    expect(await worktreeHead()).toBe(next);
    expect((await exec("git", ["branch", "--show-current"], { cwd: first.path })).stdout.trim()).toBe("");
    // A worker commit no one pushed: the PR head doesn't contain it, so moving would lose it.
    await exec("git", ["commit", "--allow-empty", "-m", "Unpushed worker commit"], { cwd: first.path });
    const unpushed = await worktreeHead();
    const later = await f.advanceHead();
    expect(await prepareAdvanceWorkspace(f.run, f.gh, { ...behind, expectedHeadOid: later, moveCleanToHead: true }, f.root))
      .toMatchObject({ ok: false, error: expect.stringContaining("unpushed") });
    expect(await worktreeHead()).toBe(unpushed);
    // Uncommitted changes are never moved either.
    await exec("git", ["reset", "--quiet", "--hard", next], { cwd: first.path });
    await writeFile(join(first.path, "file.txt"), "unfinished edit\n");
    expect(await prepareAdvanceWorkspace(f.run, f.gh, { ...behind, expectedHeadOid: later, moveCleanToHead: true }, f.root))
      .toMatchObject({ ok: false, error: expect.stringContaining("preserved") });
    expect([await worktreeHead(), await readFile(join(first.path, "file.txt"), "utf8")]).toEqual([next, "unfinished edit\n"]);
  });

  it("reuses only a checkout that already exists, never creating one, and runs a draft only there", async () => {
    const f = await fixture();
    expect(await prepareAdvanceWorkspace(f.run, f.gh, { ...f.input, reuseOnly: true }, f.root))
      .toMatchObject({ ok: false, error: expect.stringContaining("Nothing was created") });
    expect((await f.git("worktree", "list", "--porcelain")).match(/^worktree /gmu)).toHaveLength(1);
    await expect(stat(join(f.root, "batch-1"))).rejects.toMatchObject({ code: "ENOENT" });
    const first = await prepareAdvanceWorkspace(f.run, f.gh, f.input, f.root);
    if (!first.ok) throw new Error(first.error);
    f.live.isDraft = true;
    expect(await prepareAdvanceWorkspace(f.run, f.gh, f.input, f.root)).toMatchObject({ ok: false, error: expect.stringContaining("a draft") });
    expect(await prepareAdvanceWorkspace(f.run, f.gh, { ...f.input, reuseOnly: true }, f.root)).toMatchObject({ ok: true, path: first.path, created: false });
  });

  it("rejects traversal in batch identifiers before any git command", async () => {
    let called = false;
    const run: AdvanceGitRunner = async () => { called = true; return { ok: false, error: "unexpected" }; };
    expect(await prepareAdvanceWorkspace(run, async () => ({ ok: false, error: "unexpected" }), {
      sourcePath: "/synthetic", prUrl: "https://github.com/example/widget/pull/42", expectedHeadOid: "a".repeat(40), expectedBaseOid: "b".repeat(40), batchId: "../escape", jobId: "job",
    })).toMatchObject({ ok: false });
    expect(called).toBe(false);
  });
});

describe("candidate checkout inspection", () => {
  // Choosing where v2 works must not change any checkout: these are the only git commands it may run.
  const READS = [["rev-parse"], ["status", "--porcelain"], ["cat-file", "-e"], ["merge-base", "--is-ancestor"]];
  function readOnly(run: AdvanceGitRunner) {
    const refused: string[] = [];
    const guarded: AdvanceGitRunner = async (args, cwd) => {
      if (READS.some((prefix) => prefix.every((word, index) => args[index] === word))) return run(args, cwd);
      refused.push(args.join(" "));
      return { ok: false, error: "refused" };
    };
    return { guarded, refused };
  }
  async function worktree(f: Awaited<ReturnType<typeof fixture>>) {
    const created = await prepareAdvanceWorkspace(f.run, f.gh, f.input, f.root);
    if (!created.ok) throw new Error(created.error);
    return created.path;
  }

  it("reads a worktree and the author checkout it came from, sharing one Git directory, without touching either", async () => {
    const f = await fixture();
    const path = await worktree(f);
    const { guarded, refused } = readOnly(f.run);
    const detached = await inspectCheckout(guarded, { path, expectedHeadOid: f.head });
    const author = await inspectCheckout(guarded, { path: f.sourcePath, expectedHeadOid: f.head });
    expect(detached).toMatchObject({ ok: true, head: f.head, branch: null, clean: true, relation: "at-head" });
    expect(author).toMatchObject({ ok: true, head: f.head, branch: "feature", clean: false, relation: "at-head" });
    expect(detached.ok && author.ok && detached.commonDir === author.commonDir).toBe(true);
    expect(await readFile(join(f.sourcePath, "file.txt"), "utf8")).toBe("uncommitted author work\n");
    expect(refused).toEqual([]);
  });

  it("tells a clean worktree behind the PR head from one holding commits the PR lacks, and never guesses without the head", async () => {
    const f = await fixture();
    const path = await worktree(f);
    await f.git("commit", "--allow-empty", "-m", "Reviewer follow-up");
    const next = await f.git("rev-parse", "HEAD");
    const { guarded, refused } = readOnly(f.run);
    expect(await inspectCheckout(guarded, { path, expectedHeadOid: next })).toMatchObject({ ok: true, relation: "behind" });
    // A PR head this repository never fetched can't prove the worktree holds no unpushed commits.
    expect(await inspectCheckout(guarded, { path, expectedHeadOid: "d".repeat(40) })).toMatchObject({ ok: true, relation: "unknown" });
    await exec("git", ["commit", "--allow-empty", "-m", "Unpushed worker commit"], { cwd: path });
    expect(await inspectCheckout(guarded, { path, expectedHeadOid: next })).toMatchObject({ ok: true, relation: "diverged" });
    expect(refused).toEqual([]);
  });

  it("refuses a directory inside a checkout, or one that is gone, instead of reading the checkout around it", async () => {
    const f = await fixture();
    await mkdir(join(f.sourcePath, "nested"));
    const { guarded } = readOnly(f.run);
    expect(await inspectCheckout(guarded, { path: join(f.sourcePath, "nested"), expectedHeadOid: f.head }))
      .toMatchObject({ ok: false, error: expect.stringContaining("not a checkout root") });
    expect(await inspectCheckout(guarded, { path: join(f.directory, "gone"), expectedHeadOid: f.head })).toMatchObject({ ok: false });
  });
});
