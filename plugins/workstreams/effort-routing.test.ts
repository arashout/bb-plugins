import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEffortStore, EFFORT_MIGRATIONS, REPO_CONTROLLER_MIGRATION } from "./effort-store.js";
import { activeCheckoutThread, effortParent } from "./effort-routing.js";

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
const prUrl = "https://github.com/inkwell/folio/pull/42";
const parent = (id: string) => ({ id, title: id, status: "idle", canSpawnChild: true, archivedAt: null as number | null, deletedAt: null as number | null });
function setup() {
  const db = new Database(":memory:"); databases.push(db);
  EFFORT_MIGRATIONS.forEach((sql) => db.exec(sql));
  db.exec(REPO_CONTROLLER_MIGRATION);
  const store = createEffortStore(db);
  const record = store.establish({ sourceKey: "a", name: "Review", goal: "Improve reviews", projectId: "project", members: { tickets: [], prUrls: [prUrl] } });
  const effort = store.save({ ...record, coordinatorThreadId: "coordinator", coordinatorState: "ready" });
  return { store, effort };
}

describe("effort repository parents", () => {
  it("routes new PR work to its repository controller and retains historical PR worker links", async () => {
    const { store, effort } = setup();
    store.recordWorker(effort.id, "worker", prUrl, "pr");
    store.recordWorker(effort.id, "followup", prUrl, "followup");
    const { record: controller } = store.claimRepoController({ effortId: effort.id, repo: "inkwell/folio", projectId: "repo-project", hostId: "host" });
    store.saveRepoController({ ...controller, threadId: "repo-controller", state: "ready" });
    const get = vi.fn(async (id: string) => parent(id));
    expect(await effortParent(store, effort, prUrl, get)).toMatchObject({ role: "pr", thread: { id: "repo-controller" } });
    expect(get).toHaveBeenCalledTimes(1);
    expect(store.workers(effort.id, prUrl)).toEqual(expect.arrayContaining([{ threadId: "worker", role: "pr" }, { threadId: "followup", role: "followup" }]));
  });

  it.each([
    { archivedAt: 1 }, { deletedAt: 1 }, { canSpawnChild: false },
  ])("does not fall back to a coordinator or prior PR worker when its controller cannot own a child: %j", async (change) => {
    const { store, effort } = setup();
    store.recordWorker(effort.id, "worker", prUrl, "pr");
    const { record: controller } = store.claimRepoController({ effortId: effort.id, repo: "inkwell/folio", projectId: "repo-project", hostId: "host" });
    store.saveRepoController({ ...controller, threadId: "repo-controller", state: "ready" });
    expect(await effortParent(store, effort, prUrl, async (id) => ({ ...parent(id), ...change }))).toBeNull();
  });

  it("returns no parent before a controller exists or when its thread is missing", async () => {
    const { store, effort } = setup();
    store.recordWorker(effort.id, "worker", prUrl, "pr");
    expect(await effortParent(store, effort, prUrl, async (id) => parent(id))).toBeNull();
    const { record: controller } = store.claimRepoController({ effortId: effort.id, repo: "inkwell/folio", projectId: "repo-project", hostId: "host" });
    store.saveRepoController({ ...controller, threadId: "repo-controller", state: "ready" });
    expect(await effortParent(store, effort, prUrl, async () => { throw new Error("missing"); })).toBeNull();
  });
});

describe("active checkout ownership", () => {
  it("blocks only the same path on the same host, including waiting writers and unknown hosts", async () => {
    const base = { id: "writer", status: "running", environmentPath: "/work/repo/", environmentHostId: "host-a" };
    expect(await activeCheckoutThread("/work/repo", "host-a", async () => [base])).toBe("writer");
    expect(await activeCheckoutThread("/work/repo", "host-b", async () => [base])).toBeNull();
    expect(await activeCheckoutThread("/work/repo-other", "host-a", async () => [base])).toBeNull();
    expect(await activeCheckoutThread("/work/repo", "host-a", async () => [{ ...base, status: "waiting", environmentHostId: null }])).toBe("writer");
    expect(await activeCheckoutThread("/work/repo", "host-a", async () => [{ ...base, status: "idle" }, { ...base, id: "failed", status: "error" }])).toBeNull();
  });

  it("checks later pages instead of overlooking a writer outside the first hundred threads", async () => {
    const page = Array.from({ length: 100 }, (_, index) => ({ id: `thread-${index}`, status: "idle", environmentPath: null }));
    const list = vi.fn(async (offset: number) => offset === 0 ? page : [{ id: "writer", status: "running", environmentPath: "/work/repo" }]);
    expect(await activeCheckoutThread("/work/repo", "host", list)).toBe("writer");
    expect(list.mock.calls.map(([offset]) => offset)).toEqual([0, 100]);
  });

  it("fails closed when ownership cannot be read or the traversal is incomplete", async () => {
    await expect(activeCheckoutThread("/work/repo", "host", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    const page = Array.from({ length: 100 }, (_, index) => ({ id: `thread-${index}`, status: "idle", environmentPath: null }));
    await expect(activeCheckoutThread("/work/repo", "host", async () => page)).rejects.toThrow("Too many threads");
  });
});
