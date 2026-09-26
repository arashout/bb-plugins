import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ADVANCE_MIGRATIONS } from "./bulk-advance.js";
import { DISPATCH_MIGRATIONS } from "./dispatch.js";
import { EFFORT_MIGRATIONS } from "./effort-store.js";
import { INVENTORY_MIGRATIONS } from "./inventory-store.js";
import { LINEAR_DETAIL_MIGRATION } from "./linearsync.js";
import { PR_HOLD_MIGRATIONS } from "./pr-hold-store.js";
import { RUNS_MIGRATION } from "./runstore.js";
import plugin from "./server.js";

// The deployed migration prefix must remain byte-for-byte and index-for-index
// stable. A previous plugin load records these statements before a reload.
const deployedMigrations = [
  `CREATE TABLE IF NOT EXISTS units (path TEXT PRIMARY KEY, unit TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS linear_tickets (ticket TEXT PRIMARY KEY, project TEXT, fetched_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cluster_decisions (hash TEXT PRIMARY KEY, summary TEXT, label TEXT, fit REAL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS effort_names (member_hash TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `ALTER TABLE effort_names ADD COLUMN level TEXT NOT NULL DEFAULT 'effort'`,
  `ALTER TABLE effort_names ADD COLUMN cohesion TEXT`,
  `ALTER TABLE effort_names ADD COLUMN cohesion_reason TEXT`,
  `CREATE TABLE IF NOT EXISTS group_assignments (level TEXT NOT NULL, member_hash TEXT NOT NULL, label TEXT NOT NULL, fit REAL NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (level, member_hash))`,
  `CREATE TABLE IF NOT EXISTS thread_paths (thread_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, paths TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS unit_transitions (path TEXT PRIMARY KEY, lifecycle TEXT NOT NULL, entered_at INTEGER)`,
  RUNS_MIGRATION,
  LINEAR_DETAIL_MIGRATION,
  `CREATE TABLE IF NOT EXISTS cluster_asks (ticket TEXT PRIMARY KEY, hash TEXT NOT NULL, streak INTEGER NOT NULL, pinned INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pr_linkbacks (url TEXT PRIMARY KEY, ticket TEXT, checked_at INTEGER NOT NULL, final INTEGER NOT NULL)`,
  ...DISPATCH_MIGRATIONS,
  ...INVENTORY_MIGRATIONS,
  ...EFFORT_MIGRATIONS,
  `CREATE TABLE IF NOT EXISTS grouping_repairs (ticket TEXT PRIMARY KEY, label TEXT NOT NULL, hash TEXT NOT NULL, evidence TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS grouping_legacy_labels (hash TEXT PRIMARY KEY, label TEXT NOT NULL)`,
  ...ADVANCE_MIGRATIONS,
  ...PR_HOLD_MIGRATIONS,
  `CREATE TABLE IF NOT EXISTS thread_work_intent_ids (thread_id TEXT PRIMARY KEY)`,
];

describe("deployed Workstreams database upgrade", () => {
  it("reloads the old migration prefix and preserves existing data", async () => {
    expect(createHash("sha256").update(JSON.stringify(deployedMigrations)).digest("hex"))
      .toBe("b51b3353d856547221cd0acf493d59a5b5482bd2a6b42bed6663bc91b4fc0eb6");
    const { bb, harness } = createFakePluginHost({
      pluginId: "workstreams",
      settings: { scanRoots: "/p" },
      sdk: {
        system: { config: async () => ({ primaryHostId: "host-synthetic" }) as never },
        threads: {
          list: async () => [] as never,
          getPluginMetadata: async () => ({}) as never,
          events: { list: async () => [] },
        },
      },
    });
    bb.storage.migrate(bb.storage.database(), deployedMigrations);
    bb.storage.database().prepare("INSERT INTO grouping_repairs (ticket, label, hash, evidence) VALUES (?, ?, ?, ?)")
      .run("TEST-1", "Synthetic group", "hash-1", "{}");

    const upgraded = await harness.lifecycle.reload(plugin);
    const db = upgraded.bb.storage.database();
    expect(db.prepare("SELECT label FROM grouping_repairs WHERE ticket = ?").get("TEST-1"))
      .toEqual({ label: "Synthetic group" });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("effort_repo_controllers"))
      .toEqual({ name: "effort_repo_controllers" });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("thread_pr_link_ids"))
      .toEqual({ name: "thread_pr_link_ids" });
    await upgraded.harness.lifecycle.dispose();
  });
});
