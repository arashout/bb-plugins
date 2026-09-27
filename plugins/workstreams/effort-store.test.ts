import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createEffortStore, EFFORT_MIGRATIONS, REPO_CONTROLLER_MIGRATION, normalizeMembers, sameMembers } from "./effort-store.js";

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
const url = "https://github.com/inkwell/folio/pull/42";
const input = { sourceKey: "suggested", name: "Improve review", goal: "Review manuscripts reliably", projectId: "project", members: { tickets: ["ABC-101"], prUrls: [url] } };
function setup() {
  const db = new Database(":memory:"); databases.push(db);
  EFFORT_MIGRATIONS.forEach((sql) => db.exec(sql));
  db.exec(REPO_CONTROLLER_MIGRATION);
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

  it("inherits an unowned PR cohort once and leaves explicit ownership untouched", () => {
    const { store, db } = setup();
    const destination = store.establish({ ...input, sourceKey: "destination", members: { tickets: [], prUrls: [] }, coordinatorState: "none" });
    const conflicting = store.establish({ ...input, sourceKey: "other", members: { tickets: ["ABC-202"], prUrls: [] } });
    const cohort = { tickets: ["ABC-101"], prUrls: [url] };
    expect(store.claimUnowned(destination.key, cohort)).toMatchObject({ conflict: false, claimed: cohort });
    expect(store.claimUnowned(destination.key, cohort)).toMatchObject({ conflict: false, claimed: { tickets: [], prUrls: [] } });
    const blocked = { tickets: ["ABC-202"], prUrls: ["https://github.com/inkwell/folio/pull/43"] };
    expect(store.claimUnowned(destination.key, blocked)).toMatchObject({ conflict: true, claimed: { tickets: [], prUrls: [] } });
    expect(store.owner("ticket", "ABC-202")?.id).toBe(conflicting.id);
    expect(store.owner("prUrl", blocked.prUrls[0]!)?.id).toBeUndefined();
    const sibling = "https://github.com/inkwell/folio/pull/44";
    store.claimUnowned(conflicting.key, { tickets: [], prUrls: [sibling] });
    expect(store.claimUnowned(destination.key, { tickets: ["ABC-303"], prUrls: [blocked.prUrls[0]!] },
      { tickets: ["ABC-303"], prUrls: [blocked.prUrls[0]!, sibling] })).toMatchObject({ conflict: true });
    expect(store.owner("ticket", "ABC-303")).toBeNull();
    expect(createEffortStore(db).get(destination.id)?.members).toEqual(cohort);
  });

  it("sees explicit PR owners across copied URL variants without rewriting their rows", () => {
    const { store, db } = setup();
    const copied = `${url.toUpperCase()}/?view=files`;
    const owner = store.establish({ ...input, sourceKey: "legacy", members: { tickets: [], prUrls: [copied] } });
    const destination = store.establish({ ...input, sourceKey: "new", members: { tickets: [], prUrls: [] } });
    expect(store.claimUnowned(destination.key, { tickets: ["ABC-101"], prUrls: [url] })).toMatchObject({ conflict: true });
    expect(store.owner("ticket", "ABC-101")).toBeNull();
    expect(store.get(owner.id)?.members.prUrls).toEqual([copied.toLowerCase()]);
    expect((db.prepare(`SELECT ref FROM effort_members WHERE effort_id = ?`).all(owner.id) as { ref: string }[])
      .map((row) => row.ref)).toEqual([copied.toLowerCase()]);
    expect(() => store.transfer("suggested-group", { tickets: [], prUrls: [] },
      { name: "Suggested", members: { tickets: [], prUrls: [url] } })).toThrow("Destination membership changed");
  });

  it("moves a copied PR URL by canonical identity and removes its old row and JSON member", () => {
    const { store, db } = setup();
    const copied = `${url.toUpperCase()}/?view=files`;
    const previous = store.establish({ ...input, sourceKey: "legacy", members: { tickets: [], prUrls: [copied] } });
    const destination = store.establish({ ...input, sourceKey: "destination", members: { tickets: [], prUrls: [] } });
    expect(store.owner("prUrl", url)?.id).toBe(previous.id);
    store.transfer(destination.key, { tickets: [], prUrls: [url] });
    const reloaded = createEffortStore(db);
    expect(reloaded.owner("prUrl", `${url}/?tab=files`)?.id).toBe(destination.id);
    expect(reloaded.get(previous.id)?.members.prUrls).toEqual([]);
    expect(reloaded.get(destination.id)?.members.prUrls).toEqual([url]);
    expect((db.prepare(`SELECT ref FROM effort_members WHERE kind = 'prUrl'`).all() as { ref: string }[])
      .map((row) => row.ref)).toEqual([url]);
  });

  it("rejects conflicting copied-URL owners without changing either effort", () => {
    const { store } = setup();
    const legacy = store.establish({ ...input, sourceKey: "legacy", members: { tickets: [], prUrls: [`${url}/?view=files`] } });
    const exact = store.establish({ ...input, sourceKey: "exact", members: { tickets: [], prUrls: [url] } });
    const destination = store.establish({ ...input, sourceKey: "destination", members: { tickets: [], prUrls: [] } });
    expect(() => store.transfer(destination.key, { tickets: [], prUrls: [url] })).toThrow("Conflicting ownership");
    expect(store.get(legacy.id)?.members.prUrls).toEqual([`${url}/?view=files`]);
    expect(store.get(exact.id)?.members.prUrls).toEqual([url]);
    expect(store.get(destination.id)?.members.prUrls).toEqual([]);
  });

  it("rejects an oversized automatic claim before changing ownership or the readable effort", () => {
    const { store, db } = setup();
    const tickets = Array.from({ length: 1000 }, (_, index) => `ABC-${index}`);
    const destination = store.establish({ ...input, members: { tickets, prUrls: [] } });
    const extra = "ABC-1000";
    expect(() => store.claimUnowned(destination.key, { tickets: [extra], prUrls: [url] })).toThrow();
    expect(store.owner("ticket", extra)).toBeNull();
    expect(store.owner("prUrl", url)).toBeNull();
    expect(createEffortStore(db).get(destination.id)?.members).toEqual(normalizeMembers({ tickets, prUrls: [] }));
    expect(store.list()).toHaveLength(1);
  });
});
