/**
 * A cross-process lock over one cache entry.
 *
 * **Why this is hand-built.** Nothing in the published SDK is a mutex.
 * `experimental_retainWorker()` returns a lease that keeps a host worker alive
 * past the current call and says nothing about exclusion, and bb's own
 * ref-mutation lock lives in a private package. Two threads created at the
 * same moment against one repo is the *expected* case — that is what "open
 * four threads on this project" means — and two `git clone --bare` calls into
 * one directory produce a corrupt cache, not a slow one.
 *
 * **Two layers, because the contenders are usually in one process.** The
 * common collision is two `create()` calls in the same host worker, which a
 * promise chain settles with no filesystem work at all. The file lock beneath
 * it covers the real but rarer case: a second daemon, or a worker restarted
 * mid-clone.
 *
 * **Staleness is time-based, not pid-based.** A pid check cannot distinguish a
 * dead holder from one on another machine sharing the directory over a network
 * filesystem, and pid reuse makes a live answer untrustworthy anyway. The
 * holder instead touches the lock while it works, so "nobody has touched this
 * in `staleMs`" is a statement about the work rather than about a process.
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** How long a lock may go untouched before another holder may break it. */
export const DEFAULT_STALE_MS = 60_000;
/** How often the holder touches the lock while it works. */
export const DEFAULT_HEARTBEAT_MS = 10_000;

export interface LockOptions {
  staleMs?: number;
  heartbeatMs?: number;
  /** Fail rather than wait forever. A caller's own timeout still applies. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called once when the lock is not immediately available. */
  onWait?: (holder: string | null) => void;
}

export class LockTimeoutError extends Error {}

/** In-process serialization, keyed by the lock directory. */
const chains = new Map<string, Promise<unknown>>();

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    if (signal?.aborted === true) {
      clearTimeout(timer);
      reject(new Error("aborted"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readHolder(lockDir: string): Promise<string | null> {
  try {
    return (await readFile(path.join(lockDir, "owner"), "utf8")).slice(0, 200);
  } catch {
    return null;
  }
}

async function ageMs(lockDir: string): Promise<number | null> {
  try {
    const info = await stat(path.join(lockDir, "owner"));
    return Date.now() - info.mtimeMs;
  } catch {
    // No owner file: either the directory was just created and the owner file
    // is not written yet, or a holder died between the two. Fall back to the
    // directory itself, which always exists once the lock is taken.
    try {
      const info = await stat(lockDir);
      return Date.now() - info.mtimeMs;
    } catch {
      return null;
    }
  }
}

/**
 * Hold `lockPath` for the duration of `body`.
 *
 * The lock is a directory, because `mkdir` is the one filesystem call that
 * both creates and tests for existence atomically on every platform bb runs
 * on — an `exists` check followed by a create has a window, and `open(…,'wx')`
 * behaves differently enough on network filesystems to be worth avoiding.
 */
/**
 * Hold `lockPath` for the duration of `body`.
 *
 * `timeoutMs` and `onWait` bound and describe the *whole* acquisition, not
 * just the filesystem half — a caller queued behind an in-process holder is
 * waiting for exactly the same thing and must not silently wait forever.
 */
export async function withLock<T>(
  lockPath: string,
  options: LockOptions,
  body: () => Promise<T>,
): Promise<T> {
  const deadline = options.timeoutMs === undefined ? null : Date.now() + options.timeoutMs;
  const previous = chains.get(lockPath);
  const waiting = { announced: false };
  const announce = async (): Promise<void> => {
    if (waiting.announced) return;
    waiting.announced = true;
    options.onWait?.(await readHolder(lockPath));
  };

  const run = (async (): Promise<T> => {
    if (previous !== undefined) {
      // Another caller in this process holds it or is queued for it. Wait on
      // the chain rather than on the filesystem: it is the same exclusion,
      // reached without a single `mkdir`.
      await announce();
      await untilSettled(previous, lockPath, deadline, options.signal);
    }
    return withFileLock(lockPath, options, body, deadline, announce);
  })();

  // The tail must never reject: it is what the *next* caller waits on, and one
  // failed clone must not reject the wait of whoever queued behind it. This
  // call still receives the real outcome through `run`.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(lockPath, tail);
  try {
    return await run;
  } finally {
    // Only the last waiter clears the entry. If someone queued behind us the
    // map already holds their tail, and deleting it would let a third caller
    // start concurrently with them.
    if (chains.get(lockPath) === tail) chains.delete(lockPath);
  }
}

/**
 * Wait for the in-process holder, giving up at the deadline.
 *
 * Abandoning the wait does not weaken the exclusion: the file lock below is
 * the real guarantee, and a caller that gives up here never reaches a body.
 */
async function untilSettled(
  previous: Promise<unknown>,
  lockPath: string,
  deadline: number | null,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (deadline === null) {
    await previous.catch(() => undefined);
    return;
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new LockTimeoutError(`Timed out waiting for ${lockPath}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), remaining);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([previous.then(() => "settled" as const, () => "settled" as const), expiry]);
    if (outcome === "timeout") throw new LockTimeoutError(`Timed out waiting for ${lockPath}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (signal?.aborted === true) throw new Error("aborted");
}

async function withFileLock<T>(
  lockPath: string,
  options: LockOptions,
  body: () => Promise<T>,
  deadline: number | null,
  announce: () => Promise<void>,
): Promise<T> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const owner = `${process.pid}@${Date.now()}`;

  await mkdir(path.dirname(lockPath), { recursive: true });

  for (;;) {
    if (options.signal?.aborted === true) throw new Error("aborted");
    let acquired = false;
    try {
      await mkdir(lockPath);
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    if (acquired) {
      await writeFile(path.join(lockPath, "owner"), owner, "utf8");
      const beat = setInterval(() => {
        // Best effort. A failed touch only risks another holder judging this
        // lock stale, which the staleness window is already sized for.
        void writeFile(path.join(lockPath, "owner"), owner, "utf8").catch(() => undefined);
      }, heartbeatMs);
      beat.unref?.();
      try {
        return await body();
      } finally {
        clearInterval(beat);
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    const age = await ageMs(lockPath);
    if (age !== null && age > staleMs) {
      // The holder stopped touching it. Break the lock and retry rather than
      // taking it directly: two waiters can reach this point together, and the
      // `mkdir` above is what decides between them.
      await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
      continue;
    }

    await announce();
    if (deadline !== null && Date.now() > deadline) {
      throw new LockTimeoutError(`Timed out waiting for ${lockPath}`);
    }
    await sleep(150 + Math.floor(Math.random() * 150), options.signal);
  }
}
