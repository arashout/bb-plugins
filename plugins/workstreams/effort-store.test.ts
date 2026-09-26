import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createEffortStore, EFFORT_MIGRATIONS, normalizeMembers, sameMembers } from "./effort-store.js";

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
const url = "https://github.com/inkwell/folio/pull/42";
const input = { sourceKey: "suggested", name: "Improve review", goal: "Review manuscripts reliably", projectId: "project", members: { tickets: ["ABC-101"], prUrls: [url] } };
function setup() {
  const db = new Database(":memory:"); databases.push(db);
  EFFORT_MIGRATIONS.forEach((sql) => db.exec(sql));
  return { db, store: createEffortStore(db, () => 1000) };
}

describe("established effort storage", () => {
  it("keeps one durable identity across the suggested key, stable key, and reload", () => {
    const { store, db } = setup();
    const first = store.establish(input);
    expect(store.establish(input)).toEqual(first);
    expect(store.establish({ ...input, sourceKey: first.key })).toEqual(first);
    const reloaded = createEffortStore(db);
    expect(reloaded.source(input.sourceKey)).toEqual(first);
    expect(reloaded.get(first.id)).toEqual(first);
    expect(reloaded.get(first.key)).toEqual(first);
    expect(reloaded.owner("ticket", "ABC-101")?.id).toBe(first.id);
    expect(reloaded.owner("prUrl", url.toUpperCase())?.id).toBe(first.id);
    expect(reloaded.list()).toHaveLength(1);
  });

  it("rejects conflicting ownership without leaving partial new effort or member records", () => {
    const { store } = setup();
    const first = store.establish(input);
    for (const members of [
      { tickets: ["ABC-202", "ABC-101"], prUrls: [] },
      { tickets: ["ABC-202"], prUrls: [url.toUpperCase()] },
    ]) expect(() => store.establish({ ...input, sourceKey: "another", members })).toThrow("already belongs");
    expect(store.source("another")).toBeNull();
    expect(store.owner("ticket", "ABC-202")).toBeNull();
    expect(store.list().map((effort) => effort.id)).toEqual([first.id]);
  });

  it("normalizes membership for order-independent stale-preview checks", () => {
    const members = { tickets: ["ABC-202", "ABC-101", "ABC-101"], prUrls: [url.toUpperCase(), url] };
    expect(normalizeMembers(members)).toEqual({ tickets: ["ABC-101", "ABC-202"], prUrls: [url] });
    expect(sameMembers(members, { tickets: ["ABC-101", "ABC-202"], prUrls: [url] })).toBe(true);
    expect(sameMembers(members, input.members)).toBe(false);
  });

  it("keeps worker history tied to one effort and PR", () => {
    const { store } = setup();
    const effort = store.establish(input);
    store.recordWorker(effort.id, "worker", url.toUpperCase(), "pr");
    store.recordWorker(effort.id, "followup", url, "followup");
    expect(store.workers(effort.id, url).map((worker) => worker.threadId).sort()).toEqual(["followup", "worker"]);
    expect(store.workers("another-effort", url)).toEqual([]);
    expect(store.workers(effort.id, `${url}0`)).toEqual([]);
  });

  it("promotes an ordinary group and transfers a ticket with its PRs atomically", () => {
    const { store, db } = setup();
    const source = store.establish(input);
    store.recordWorker(source.id, "worker", url, "pr");
    const other = "https://github.com/inkwell/folio/pull/43";
    const destination = store.transfer("ordinary-group", { tickets: ["ABC-101"], prUrls: [url] },
      { name: "Editorial workflow", members: { tickets: ["ABC-202"], prUrls: [other] } });
    expect(destination).toMatchObject({ name: "Editorial workflow", coordinatorState: "none",
      members: { tickets: ["ABC-101", "ABC-202"], prUrls: [url, other] } });
    expect(store.source("ordinary-group")?.id).toBe(destination.id);
    expect(store.owner("ticket", "ABC-101")?.id).toBe(destination.id);
    expect(store.owner("prUrl", url)?.id).toBe(destination.id);
    expect(store.get(source.id)?.members).toEqual({ tickets: [], prUrls: [] });
    expect(store.workers(source.id, url)).toEqual([{ threadId: "worker", role: "pr" }]);
    const reloaded = createEffortStore(db);
    expect(reloaded.owner("ticket", "ABC-202")?.id).toBe(destination.id);
    expect(reloaded.owner("prUrl", other)?.id).toBe(destination.id);
  });

  it("rolls back promotion when one inherited member is already owned", () => {
    const { store } = setup();
    const source = store.establish(input);
    expect(() => store.transfer("ordinary-group", { tickets: ["ABC-101"], prUrls: [url] },
      { name: "Editorial workflow", members: { tickets: ["ABC-202"], prUrls: [url] } })).toThrow("Destination membership changed");
    expect(store.source("ordinary-group")).toBeNull();
    expect(store.owner("ticket", "ABC-202")).toBeNull();
    expect(store.owner("ticket", "ABC-101")?.id).toBe(source.id);
  });

  it("does not restore stale membership during an unrelated coordinator state save", () => {
    const { store } = setup();
    const captured = store.establish(input);
    const destination = store.establish({ ...input, sourceKey: "destination", members: { tickets: ["ABC-202"], prUrls: [] } });
    store.transfer(destination.key, input.members);
    store.save({ ...captured, coordinatorState: "ready" });
    expect(store.get(captured.id)?.members).toEqual({ tickets: [], prUrls: [] });
    expect(store.owner("ticket", "ABC-101")?.id).toBe(destination.id);
    expect(store.owner("prUrl", url)?.id).toBe(destination.id);
  });
});
