import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { canonicalConversationScope, createWorkConversationStore, validateConversationProposal, WORK_CONVERSATION_MIGRATIONS } from "./work-conversation.js";

const first = "https://github.com/example/widget/pull/12";
const second = "https://github.com/example/widget/pull/34";

describe("work conversation scope", () => {
  it("keeps the complete selected scope and exact-scope identity across reloads", () => {
    const db = new Database(":memory:");
    for (const migration of WORK_CONVERSATION_MIGRATIONS) db.exec(migration);
    const scope = canonicalConversationScope([second, "https://GitHub.com/Example/Widget/pull/12/?tab=files"]);
    const store = createWorkConversationStore(db, () => 100);
    const { record, created } = store.create(scope, "project-example");
    expect(created).toBe(true);
    expect(record.scopePrUrls).toEqual([first, second]);
    expect(store.create(scope, "project-other")).toEqual({ record, created: false });
    const reloaded = createWorkConversationStore(db, () => 200);
    expect(reloaded.byScope(scope)).toEqual(record);
    expect(reloaded.byScope([first])).toBeNull();
    db.close();
  });

  it("requires explicit reasons for every excluded PR and rejects scope growth", () => {
    expect(() => validateConversationProposal([first, second], [first], [])).toThrow(/every PR excluded/u);
    expect(() => validateConversationProposal([first, second], [first, "https://github.com/other/repo/pull/1"], []))
      .toThrow(/outside/u);
    expect(() => validateConversationProposal([first, second], [first], [{ prUrl: first, reason: "Skip" }]))
      .toThrow(/exactly once/u);
    expect(() => validateConversationProposal([first, second], [], [
      { prUrl: first, reason: "Already ready" }, { prUrl: second, reason: "On hold" },
    ])).not.toThrow();
  });

  it("rejects stale revisions rather than losing a newer proposal", () => {
    const db = new Database(":memory:");
    for (const migration of WORK_CONVERSATION_MIGRATIONS) db.exec(migration);
    const store = createWorkConversationStore(db);
    const { record } = store.create([first], "project-example");
    const updated = store.update({ ...record, threadId: "thr-conversation" }, record.revision);
    expect(updated.revision).toBe(1);
    expect(() => store.update({ ...record, threadId: "thr-stale" }, record.revision)).toThrow(/changed/u);
    expect(store.get(record.id)?.threadId).toBe("thr-conversation");
    db.close();
  });
});
