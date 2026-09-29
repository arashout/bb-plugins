/**
 * The git and `gh` argument layer.
 *
 * bb's own `runGit` lives in `bb-environment-provider-host`, which is private
 * to plugins bundled inside the bb repo, so this plugin ships its own. What it
 * does *not* ship is a process layer: `@get-bb/plugin-sdk/host` publishes
 * `experimental_spawnPortableOutputProcess` for exactly this ("host-local
 * plugin operations such as git") and `experimental_sanitizeInheritedChildProcessEnv`
 * for the environment. Argument construction, exit-code handling and output
 * parsing are built on top; spawning is not reimplemented.
 *
 * Every call passes arguments as an array. No string is ever handed to a
 * shell, so a repo URL or a branch name is data even when it contains
 * something that would otherwise be syntax.
 */
import {
  experimental_sanitizeInheritedChildProcessEnv as sanitizeEnv,
  experimental_spawnPortableOutputProcess as spawnPortable,
} from "@get-bb/plugin-sdk/host";

export interface RunResult {
  /** Null when the process was killed by a signal or never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when output was cut at `maxBytes`. */
  truncated: boolean;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly result: RunResult,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The environment every git and `gh` call inherits.
 *
 * `sanitizeEnv` strips the daemon's own `BB_*` variables and normalizes `PATH`
 * — without it a child would inherit whatever the daemon happens to hold. The
 * additions on top are all one rule: **never block on a human.** A provider
 * `create()` runs with no terminal attached, so a repo whose credentials have
 * expired must fail in seconds with "authentication failed" rather than hang
 * until the launch times out on an invisible password prompt.
 */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...sanitizeEnv({ env: base }),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    // Without this, an unknown host key turns a clone into an interactive
    // "are you sure you want to continue connecting" that nobody can answer.
    GIT_SSH_COMMAND: base.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
    // Advice and progress meters are for a terminal; here they are noise in a
    // captured stderr that gets surfaced in an error message.
    GIT_ADVICE: "0",
    GIT_PAGER: "cat",
    // `gh` paginates into a pager and colorizes when it thinks it has a tty.
    PAGER: "cat",
    NO_COLOR: "1",
    CLICOLOR: "0",
  };
}

/**
 * Run a command and collect its output.
 *
 * Never rejects on a nonzero exit: an exit code is data here. `git diff
 * --no-index` exits 1 for "there is a difference", `gh pr list` exits 0 with
 * an empty array for "no PR", and a caller that wants a throw asks for one
 * with {@link runOrThrow}.
 */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<RunResult>((resolve, reject) => {
    let child;
    try {
      child = spawnPortable({
        command,
        args: [...args],
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: options.env ?? gitEnv(),
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let settled = false;

    const collect = (chunks: Buffer[], counter: () => number, add: (n: number) => void) => (chunk: Buffer) => {
      const remaining = maxBytes - counter();
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        add(remaining);
        truncated = true;
        return;
      }
      chunks.push(chunk);
      add(chunk.length);
    };

    child.stdout.on("data", collect(out, () => outBytes, (n) => { outBytes += n; }));
    child.stderr.on("data", collect(err, () => errBytes, (n) => { errBytes += n; }));

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        truncated,
      });
    };

    // SIGTERM first so git can unlink its index.lock, then SIGKILL for the
    // subset that ignores it. A `git clone` killed without the grace leaves a
    // half-written directory the next attempt has to clean up anyway, but a
    // stale `index.lock` in a *cache* repo would block every later fetch.
    const kill = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2_000).unref?.();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      truncated = true;
      err.push(Buffer.from(`\n${command} timed out after ${timeoutMs}ms`));
      kill();
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => kill();
    if (options.signal?.aborted === true) kill();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code: number | null) => finish(code));
  });
}

/** The first line of stderr, trimmed — what an error message should carry. */
export function firstProblemLine(result: RunResult): string {
  const source = result.stderr.trim().length > 0 ? result.stderr : result.stdout;
  const line = source
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("warning:") && !entry.startsWith("hint:"))
    .pop();
  return (line ?? `exited with code ${result.code ?? "signal"}`).slice(0, 500);
}

export async function runOrThrow(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new GitError(`${command} ${args[0] ?? ""}: ${firstProblemLine(result)}`, result);
  }
  return result;
}

/**
 * Global git configuration applied to every invocation.
 *
 * `-c` rather than writing a config file: the user's own `~/.gitconfig` is not
 * this plugin's to edit, and a workspace clone must not depend on machine
 * state that a later `git config --global` could undo. These four are all
 * cases where a user's preference would break an unattended clone — a
 * `pull.rebase` prompt, a pager, a template hook, or a `core.hooksPath`
 * pointing at hooks this plugin never asked to run.
 */
const GIT_CONFIG: readonly string[] = [
  "-c", "core.hooksPath=",
  "-c", "init.templateDir=",
  "-c", "advice.detachedHead=false",
  "-c", "credential.interactive=never",
];

export function git(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return run("git", [...GIT_CONFIG, ...args], options);
}

export function gitOrThrow(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return runOrThrow("git", [...GIT_CONFIG, ...args], options);
}

/** `git -C <dir> …`, the form every repo-scoped call uses. */
export function gitIn(dir: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return git(["-C", dir, ...args], options);
}

export function gitInOrThrow(
  dir: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return gitOrThrow(["-C", dir, ...args], options);
}

/** stdout with the trailing newline removed, or null when the command failed. */
export async function gitLine(
  dir: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string | null> {
  const result = await gitIn(dir, args, options);
  return result.code === 0 ? result.stdout.trim() : null;
}

/** Split the `-z` output git uses wherever a path could contain a newline. */
export function splitNul(value: string): string[] {
  const parts = value.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}
