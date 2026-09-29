import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createAssignmentStore, EFFORT_ASSIGNMENT_MIGRATIONS } from "./effort-assignments.js";
import { createEffortStore, EFFORT_MIGRATIONS } from "./effort-store.js";

const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;

function setup() {
  const db = new Database(":memory:");
  for (const statement of [...EFFORT_MIGRATIONS, ...EFFORT_ASSIGNMENT_MIGRATIONS]) db.prepare(statement).run();
  const efforts = createEffortStore(db);
  const assignments = createAssignmentStore(db, efforts, () => 5_000);
  const effort = (name: string, members: { tickets: string[]; prUrls: string[]; checkoutPaths?: string[] }) => efforts.establish({ sourceKey: `test:${name}`,
    name, goal: "", projectId: "project-inkwell", coordinatorState: "none", members });
  const pickup = effort("Store pickup", { tickets: ["ABC-330"], prUrls: [url("spine", 150)], checkoutPaths: ["/Users/reader/spine"] });
  const shelf = effort("Shelf order", { tickets: ["ABC-341"], prUrls: [] });
  const audit = () => db.prepare(`SELECT action_id AS actionId, at, source, effort_id AS effortId, kind, ref, rule_id AS ruleId, undone_at AS undoneAt
    FROM effort_assignments ORDER BY seq`).all();
  return { db, efforts, assignments, pickup, shelf, audit };
}

describe("classification assignments", () => {
  it("records one audit row per PR and ticket an action gives an effort", () => {
    const { efforts, assignments, pickup, audit } = setup();
    const result = assignments.assign({ effortId: pickup.id, source: "assign", prUrls: [url("spine", 151), url("spine", 152)], tickets: ["ABC-331"] });
    // `added` counts PRs, so a "2 moved" line matches the rows that moved.
    expect(result).toMatchObject({ added: 2, effort: { id: pickup.id } });
    expect(audit()).toEqual([
      { actionId: result.actionId, at: 5_000, source: "assign", effortId: pickup.id, kind: "prUrl", ref: url("spine", 151), ruleId: null, undoneAt: null },
      { actionId: result.actionId, at: 5_000, source: "assign", effortId: pickup.id, kind: "prUrl", ref: url("spine", 152), ruleId: null, undoneAt: null },
      { actionId: result.actionId, at: 5_000, source: "assign", effortId: pickup.id, kind: "ticket", ref: "ABC-331", ruleId: null, undoneAt: null },
    ]);
    expect(efforts.owner("prUrl", url("spine", 152))?.id).toBe(pickup.id);
    expect(efforts.owner("ticket", "ABC-331")?.id).toBe(pickup.id);
  });

  // Classification only sorts unowned work: taking a PR or ticket another effort owns would be a silent move.
  it("assigns nothing when another effort owns any of the work", () => {
    const { efforts, assignments, pickup, shelf, audit } = setup();
    expect(() => assignments.assign({ effortId: shelf.id, source: "assign", prUrls: [url("folio", 314), url("spine", 150)] }))
      .toThrow("Another effort owns some of this work now");
    expect(() => assignments.assign({ effortId: shelf.id, source: "assign", prUrls: [url("folio", 314)], tickets: ["ABC-330"] }))
      .toThrow("Another effort owns some of this work now");
    expect(efforts.owner("prUrl", url("folio", 314))).toBeNull();
    expect(efforts.get(pickup.id)!.members.prUrls).toEqual([url("spine", 150)]);
    expect(audit()).toEqual([]);
  });

  it("undoes exactly what one action added, keeping the effort's earlier members and checkouts", () => {
    const { efforts, assignments, pickup, audit } = setup();
    const before = efforts.get(pickup.id)!.members;
    const { actionId } = assignments.assign({ effortId: pickup.id, source: "assign", prUrls: [url("spine", 151)], tickets: ["ABC-331"] });
    expect(assignments.undo(actionId)).toEqual({ effortId: pickup.id, source: "assign" });
    expect(efforts.get(pickup.id)!.members).toEqual(before);
    expect(efforts.owner("prUrl", url("spine", 151))).toBeNull();
    expect(efforts.owner("ticket", "ABC-331")).toBeNull();
    // The audit keeps the action, marked undone, and a second undo finds nothing to reverse.
    expect(audit()).toMatchObject([{ ref: url("spine", 151), undoneAt: 5_000 }, { ref: "ABC-331", undoneAt: 5_000 }]);
    expect(() => assignments.undo(actionId)).toThrow("Nothing to undo.");
  });

  it("refuses an undo once any of its work moved to another effort, and releases nothing", () => {
    const { efforts, assignments, pickup, shelf } = setup();
    const { actionId } = assignments.assign({ effortId: pickup.id, source: "one-off", prUrls: [url("spine", 151), url("spine", 152)] });
    efforts.transfer(shelf.key, { tickets: [], prUrls: [url("spine", 152)] });
    expect(() => assignments.undo(actionId)).toThrow("This work moved since, so Undo no longer applies.");
    expect(efforts.owner("prUrl", url("spine", 151))?.id).toBe(pickup.id);
    expect(efforts.owner("prUrl", url("spine", 152))?.id).toBe(shelf.id);
  });
});
