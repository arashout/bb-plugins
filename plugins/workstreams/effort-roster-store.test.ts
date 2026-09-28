import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEffortRosterStore, EFFORT_ROSTER_MIGRATIONS } from "./effort-roster-store.js";
import { createEffortStore, EFFORT_MIGRATIONS, REPO_CONTROLLER_MIGRATION } from "./effort-store.js";

const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});
const pr = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
const [a, b, c, d] = [pr("folio", 1), pr("quill", 2), pr("atlas", 3), pr("spine", 4)];

function open(path = ":memory:", options?: Database.Options) {
  const db = new Database(path, options);
  databases.push(db);
  if (!options?.readonly) [...EFFORT_MIGRATIONS, REPO_CONTROLLER_MIGRATION, ...EFFORT_ROSTER_MIGRATIONS].forEach((sql) => db.exec(sql));
  let clock = 1_000;
  const efforts = createEffortStore(db, () => clock);
  return { db, efforts, roster: createEffortRosterStore(db, efforts, () => ++clock) };
}
function establish(efforts: ReturnType<typeof open>["efforts"], name: string, prUrls: string[] = []) {
  return efforts.establish({ sourceKey: name, name, goal: "", projectId: "project", members: { tickets: [], prUrls } }).id;
}
const numbered = (rows: { n: number; target: string }[]) => rows.map(({ n, target }) => [n, target]);
const snapshotCount = (db: Database.Database) => (db.prepare("SELECT count(*) AS count FROM effort_roster_snapshots").get() as { count: number }).count;

describe("effort roster numbers", () => {
  it("keeps each PR's number when the roster reorders or a URL is copied in another case", () => {
    const { efforts, roster } = open();
    const effort = establish(efforts, "Reader accounts");
    expect(numbered(roster.numbers(effort, [a, b, c], { assign: true }).rows)).toEqual([[1, a], [2, b], [3, c]]);
    expect(numbered(roster.numbers(effort, [c, "https://github.com/Inkwell/Folio/pull/1/", b], { assign: true }).rows))
      .toEqual([[3, c], [1, a], [2, b]]);
    expect(() => roster.numbers(effort, ["inkwell/folio#1"], { assign: true })).toThrow("GitHub PR URLs");
  });

  it("never frees the number of a PR that left the roster or merged", () => {
    const { efforts, roster } = open();
    const effort = establish(efforts, "Reader accounts");
    roster.numbers(effort, [a, b, c], { assign: true });
    expect(numbered(roster.numbers(effort, [a, c], { assign: true }).rows)).toEqual([[1, a], [3, c]]);
    expect(numbered(roster.numbers(effort, [a, c, d], { assign: true }).rows)).toEqual([[1, a], [3, c], [4, d]]);
    expect(numbered(roster.numbers(effort, [a, b, c, d], { assign: true }).rows)).toEqual([[1, a], [2, b], [3, c], [4, d]]);
  });

  it("shares one numbering across connections", () => {
    const directory = mkdtempSync(join(tmpdir(), "workstreams-roster-"));
    directories.push(directory);
    const first = open(join(directory, "data.db"));
    const second = open(join(directory, "data.db"));
    const effort = establish(first.efforts, "Vault audits");
    first.roster.numbers(effort, [a], { assign: true });
    second.roster.numbers(effort, [b, a], { assign: true });
    first.roster.numbers(effort, [c, b], { assign: true });
    expect(numbered(second.roster.numbers(effort, [d, c, b, a], { assign: true }).rows)).toEqual([[4, d], [3, c], [2, b], [1, a]]);
    expect(first.db.prepare("SELECT ordinal, target FROM effort_roster_numbers ORDER BY ordinal").all())
      .toEqual([{ ordinal: 1, target: a }, { ordinal: 2, target: b }, { ordinal: 3, target: c }, { ordinal: 4, target: d }]);
  });

  it("fails a whole assignment that another connection races, never numbering part of a roster", () => {
    const directory = mkdtempSync(join(tmpdir(), "workstreams-roster-"));
    directories.push(directory);
    const first = open(join(directory, "data.db"), { timeout: 0 });
    const second = open(join(directory, "data.db"), { timeout: 0 });
    const effort = establish(first.efforts, "Vault audits");
    first.roster.numbers(effort, [a, b], { assign: true });
    // The second connection numbers d while the first sits between numbering c and d.
    let calls = 0;
    const racing = createEffortRosterStore(first.db, first.efforts, () => {
      if (++calls === 2) second.roster.numbers(effort, [d], { assign: true });
      return 5_000 + calls;
    });
    expect(() => racing.numbers(effort, [a, b, c, d], { assign: true })).toThrow("database is locked");
    expect(first.db.prepare("SELECT ordinal, target FROM effort_roster_numbers ORDER BY ordinal").all())
      .toEqual([{ ordinal: 1, target: a }, { ordinal: 2, target: b }]);
    expect(snapshotCount(first.db)).toBe(1);
    // Retried, every PR still gets exactly one number.
    second.roster.numbers(effort, [d], { assign: true });
    expect(numbered(first.roster.numbers(effort, [a, b, c, d], { assign: true }).rows)).toEqual([[1, a], [2, b], [4, c], [3, d]]);
  });

  it("writes a deterministic snapshot only when the numbered set changes", () => {
    const { db, efforts, roster } = open();
    const effort = establish(efforts, "Catalog follow-ups");
    const first = roster.numbers(effort, [a, b], { assign: true }).snapshotId!;
    const rows = [{ n: 1, target: a }, { n: 2, target: b }];
    expect(first).toBe(`S-${createHash("sha256").update(JSON.stringify([effort, rows])).digest("hex").slice(0, 12)}`);
    const written = roster.snapshot(first)!.createdAt;
    // A refresh after a state or head change numbers the same set again.
    expect(roster.numbers(effort, [b, a], { assign: true }).snapshotId).toBe(first);
    expect(snapshotCount(db)).toBe(1);
    expect(roster.snapshot(first)!.createdAt).toBe(written);
    const joined = roster.numbers(effort, [a, b, c], { assign: true }).snapshotId!;
    const left = roster.numbers(effort, [a, c], { assign: true }).snapshotId!;
    expect(new Set([first, joined, left]).size).toBe(3);
    expect(snapshotCount(db)).toBe(3);
    expect(roster.snapshot(first)).toMatchObject({ effortId: effort, rows, stale: false });
    // Returning to a set seen before reuses its snapshot and makes it the latest again.
    expect(roster.numbers(effort, [a, b], { assign: true }).snapshotId).toBe(first);
    expect(snapshotCount(db)).toBe(3);
    expect(roster.snapshot(first)!.createdAt).toBeGreaterThan(roster.snapshot(left)!.createdAt);
    expect(roster.numbers(effort, [a, b], { assign: true }).snapshotId).toBe(first);
    expect(snapshotCount(db)).toBe(3);
  });

  it("resolves a merged source to the destination's numbering and marks the source's snapshots stale", () => {
    const { efforts, roster } = open();
    const source = establish(efforts, "Vault audits", [a]);
    const destination = establish(efforts, "Reader accounts", [b]);
    const sourceSnapshot = roster.numbers(source, [a], { assign: true }).snapshotId!;
    const destinationSnapshot = roster.numbers(destination, [b], { assign: true }).snapshotId!;
    efforts.merge(source, destination);
    // The source's #1 was PR a; after the merge #1 is the destination's PR b, so a gets a new number.
    const merged = roster.numbers(source, [b, a], { assign: true });
    expect(merged.effortId).toBe(destination);
    expect(numbered(merged.rows)).toEqual([[1, b], [2, a]]);
    expect(roster.snapshot(sourceSnapshot)).toMatchObject({ effortId: source, rows: [{ n: 1, target: a }], stale: true });
    expect(roster.snapshot(destinationSnapshot)?.stale).toBe(false);
  });

  it("previews provisional numbers from a read-only copy without writing", () => {
    const directory = mkdtempSync(join(tmpdir(), "workstreams-roster-"));
    directories.push(directory);
    const path = join(directory, "data.db");
    const writable = open(path);
    const effort = establish(writable.efforts, "Reader accounts");
    const assigned = writable.roster.numbers(effort, [a, b], { assign: true });
    const preview = open(path, { readonly: true }).roster.numbers(effort, [b, c, a, d], { assign: false });
    expect(preview).toEqual({ effortId: effort, snapshotId: null, rows: [
      { n: 2, target: b, provisional: false }, { n: 3, target: c, provisional: true },
      { n: 1, target: a, provisional: false }, { n: 4, target: d, provisional: true },
    ] });
    expect(writable.db.prepare("SELECT count(*) AS count FROM effort_roster_numbers").get()).toEqual({ count: 2 });
    expect(snapshotCount(writable.db)).toBe(1);
    expect(writable.roster.numbers(effort, [a, b], { assign: true }).snapshotId).toBe(assigned.snapshotId);
  });

  it("previews every number as provisional from a copy made before roster numbering", () => {
    const directory = mkdtempSync(join(tmpdir(), "workstreams-roster-"));
    directories.push(directory);
    const path = join(directory, "data.db");
    // The deployed database stops at effort_admin_sync, and the dry run reads a read-only copy of it.
    const deployed = new Database(path);
    databases.push(deployed);
    [...EFFORT_MIGRATIONS, REPO_CONTROLLER_MIGRATION].forEach((sql) => deployed.exec(sql));
    const effort = establish(createEffortStore(deployed), "Reader accounts");
    expect(open(path, { readonly: true }).roster.numbers(effort, [b, a], { assign: false })).toEqual({ effortId: effort, snapshotId: null,
      rows: [{ n: 1, target: b, provisional: true }, { n: 2, target: a, provisional: true }] });
  });
});
