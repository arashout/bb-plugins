/**
 * The lock is the piece the design calls out as genuinely the plugin's to
 * build, and its failure mode — two `git clone --bare` calls into one
 * directory — corrupts a cache entry rather than merely slowing something
 * down. These exercise the real filesystem for that reason.
 */
import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockTimeoutError, withLock } from "./lock.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "multi-repo-lock-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const lockPath = () => path.join(dir, "entry.lock");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("withLock", () => {
  it("returns the body's value and releases the lock", async () => {
    const value = await withLock(lockPath(), {}, async () => "done");
    expect(value).toBe("done");
    await expect(stat(lockPath())).rejects.toThrow();
  });

  it("releases the lock when the body throws", async () => {
    await expect(withLock(lockPath(), {}, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(stat(lockPath())).rejects.toThrow();
  });

  it("serializes concurrent holders rather than overlapping them", async () => {
    let inside = 0;
    let maxInside = 0;
    const body = async () => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      await sleep(20);
      inside -= 1;
    };
    await Promise.all(Array.from({ length: 5 }, () => withLock(lockPath(), {}, body)));
    expect(maxInside).toBe(1);
  });

  it("does not let one caller's failure reject the callers queued behind it", async () => {
    const failing = withLock(lockPath(), {}, async () => {
      await sleep(10);
      throw new Error("first fails");
    });
    const following = withLock(lockPath(), {}, async () => "second succeeds");
    await expect(failing).rejects.toThrow("first fails");
    await expect(following).resolves.toBe("second succeeds");
  });

  it("breaks a lock nobody has touched for longer than the stale window", async () => {
    // Simulates a holder whose process died mid-clone: the directory is there
    // and its owner file is old.
    await mkdir(lockPath(), { recursive: true });
    await writeFile(path.join(lockPath(), "owner"), "9999@0", "utf8");
    await sleep(30);
    const value = await withLock(lockPath(), { staleMs: 10 }, async () => "took over");
    expect(value).toBe("took over");
  });

  it("does not break a lock a live holder is still touching", async () => {
    const order: string[] = [];
    const holder = withLock(lockPath(), { staleMs: 60, heartbeatMs: 10 }, async () => {
      await sleep(150);
      order.push("holder");
    });
    await sleep(20);
    const waiter = withLock(lockPath(), { staleMs: 60, heartbeatMs: 10 }, async () => {
      order.push("waiter");
    });
    await Promise.all([holder, waiter]);
    expect(order).toEqual(["holder", "waiter"]);
  });

  it("times out rather than waiting forever", async () => {
    const holder = withLock(lockPath(), { heartbeatMs: 10 }, async () => {
      await sleep(300);
    });
    await sleep(20);
    await expect(
      withLock(lockPath(), { timeoutMs: 50, heartbeatMs: 10 }, async () => "never"),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    await holder;
  });

  it("reports who it is waiting for, once", async () => {
    const waits: (string | null)[] = [];
    const holder = withLock(lockPath(), {}, async () => {
      await sleep(120);
    });
    await sleep(20);
    await withLock(lockPath(), { onWait: (who) => waits.push(who) }, async () => undefined);
    await holder;
    expect(waits).toHaveLength(1);
    expect(waits[0]).toContain(String(process.pid));
  });

  it("keeps separate entries independent", async () => {
    const order: string[] = [];
    await Promise.all([
      withLock(path.join(dir, "a.lock"), {}, async () => {
        await sleep(30);
        order.push("a");
      }),
      withLock(path.join(dir, "b.lock"), {}, async () => {
        order.push("b");
      }),
    ]);
    // `b` never waits on `a`: two different repos cache in parallel.
    expect(order).toEqual(["b", "a"]);
  });

  it("creates the parent directory if it is missing", async () => {
    const nested = path.join(dir, "deep", "nested", "entry.lock");
    await expect(withLock(nested, {}, async () => "ok")).resolves.toBe("ok");
  });
});
