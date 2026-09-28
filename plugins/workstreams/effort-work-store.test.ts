import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createEffortWorkStore, EFFORT_EXECUTION_MIGRATIONS, type V2Target } from "./effort-work-store.js";

const databases: Database.Database[] = [];
afterEach(() => { databases.splice(0).forEach((db) => db.close()); });
const pr = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
const [folio, quill, atlas] = [pr("folio", 12), pr("quill", 14), pr("atlas", 16)];

function open() {
  const db = new Database(":memory:");
  databases.push(db);
  EFFORT_EXECUTION_MIGRATIONS.forEach((sql) => db.exec(sql));
  let clock = 1_000;
  return { db, work: createEffortWorkStore(db, () => ++clock) };
}
/** The roster ownership a server read would resolve. */
const rosters: Record<string, V2Target[]> = {
  returns: [{ target: folio, source: "ticket" }, { target: quill, source: "pr" }],
  gifts: [{ target: atlas, source: "pr" }],
};
const targetsOf = (effortId: string) => rosters[effortId] ?? [];

describe("effort execution mode", () => {
  it("starts every effort on legacy with nothing fenced", () => {
    const { work } = open();
    expect(work.execution("returns")).toEqual({ mode: "legacy", revision: 0 });
    expect(work.managedBy(folio)).toBeNull();
    expect(work.active()).toBe(false);
  });

  it("changes mode only at the revision the caller saw, so a stale opt-in or opt-out changes nothing", () => {
    const { work } = open();
    expect(work.setMode("returns", "v2", 0, targetsOf)).toEqual({ mode: "v2", revision: 1 });
    expect(() => work.setMode("returns", "legacy", 0, targetsOf)).toThrow("execution mode changed");
    expect(work.execution("returns")).toEqual({ mode: "v2", revision: 1 });
    expect(work.managedBy(folio)).toBe("returns");
    expect(work.setMode("returns", "legacy", 1, targetsOf)).toEqual({ mode: "legacy", revision: 2 });
  });

  it("fences a v2 effort's roster PRs with the mode, including PRs it owns only through a ticket", () => {
    const { db, work } = open();
    work.setMode("returns", "v2", 0, targetsOf);
    expect(db.prepare("SELECT target, effort_id AS effortId, source FROM effort_v2_targets ORDER BY target").all()).toEqual([
      { target: folio, effortId: "returns", source: "ticket" }, { target: quill, effortId: "returns", source: "pr" }]);
    // Copied URL variants resolve to the same fenced PR.
    expect(work.managedBy("https://github.com/Inkwell/Folio/pull/12/")).toBe("returns");
    // A legacy effort's PRs are never written, even when a resolver would return them.
    expect(work.managedBy(atlas)).toBeNull();
  });

  it("never leaves a v2 effort unfenced: a failed target read rolls back the mode", () => {
    const { work } = open();
    expect(() => work.setMode("returns", "v2", 0, () => { throw new Error("board unavailable"); })).toThrow("board unavailable");
    expect(work.execution("returns")).toEqual({ mode: "legacy", revision: 0 });
    expect(work.active()).toBe(false);
  });

  it("rewrites every v2 effort's targets at once, and opting out clears only that effort's fence", () => {
    const { work } = open();
    work.setMode("returns", "v2", 0, targetsOf);
    work.setMode("gifts", "v2", 0, targetsOf);
    // Membership moved quill out of Returns desk: the rewrite drops it and keeps the rest.
    work.rewriteTargets((effortId) => targetsOf(effortId).filter((target) => target.target !== quill));
    expect([folio, quill, atlas].map(work.managedBy)).toEqual(["returns", null, "gifts"]);
    work.setMode("returns", "legacy", 1, targetsOf);
    expect([folio, quill, atlas].map(work.managedBy)).toEqual([null, null, "gifts"]);
    work.setMode("gifts", "legacy", 1, targetsOf);
    expect(work.active()).toBe(false);
  });
});
