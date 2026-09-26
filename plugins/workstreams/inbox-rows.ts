// Shared, pure checkout rows for the legacy Board and Pipeline.
import { prHoldFor, type PrHold } from "./pr-holds.js";
import type { Board, WireGroup, WireRun } from "./server.js";
import { INBOX_SECTIONS, byInboxOrder, displayTitle, groupChildren, inboxSection, inboxVerb, stateAge, type InboxSection, type StateAge } from "./workstreams.js";
import { primaryAction, type PrimaryAction } from "./actions.js";
import { rowRun } from "./runs.js";

type Cluster = WireGroup["clusters"][number];
type Unit = Cluster["units"][number];

/** One inbox row: a checkout and everything the row shows about it. */
export type Row = {
  key: string;
  hold?: PrHold | null;
  unit: Unit;
  cluster: Cluster;
  effortKey: string;
  effort: string;
  section: InboxSection;
  verb: string | null;
  age: StateAge;
  repo: string;
  title: string;
  /** What the row's `a` key and action button do; null when there is nothing to do. */
  action: PrimaryAction | null;
  /** The row's latest agent or direct run, while it is still worth reporting. */
  run: WireRun | null;
};

/** Every checkout on the board, as rows, grouped and ordered by section. */
export function inboxRows(board: Board, now: number): Map<InboxSection, Row[]> {
  const byParent = groupChildren(board.groups);
  const rows: Row[] = [];
  for (const group of board.groups) {
    // Clusters live on the leaves; a group with children holds none itself.
    if ((byParent.get(group.key) ?? []).length > 0) continue;
    for (const cluster of group.clusters) {
      for (const unit of cluster.units) {
        const section = inboxSection(unit, now);
        const verb = inboxVerb(unit, section);
        rows.push({
          key: unit.path,
          hold: unit.pr?.state === "OPEN" ? prHoldFor(unit.pr.url, board.prHolds) : null,
          unit,
          cluster,
          effortKey: group.key,
          effort: group.name,
          section,
          verb,
          action: primaryAction(unit, section, verb),
          age: stateAge(unit),
          run: rowRun(board.runs, unit.path, now),
          repo: unit.repo ?? unit.dirName,
          title: unit.pr === null ? (unit.branch ?? unit.dirName) : displayTitle(unit.pr.title),
        });
      }
    }
  }
  const sections = new Map<InboxSection, Row[]>(INBOX_SECTIONS.map((section) => [section, []]));
  for (const row of rows) sections.get(row.section)?.push(row);
  const facts = (row: Row) => ({
    repo: row.repo,
    prNumber: row.unit.pr?.number ?? null,
    path: row.unit.path,
    since: row.age.since,
  });
  for (const list of sections.values()) list.sort((a, b) => byInboxOrder(facts(a), facts(b)));
  return sections;
}
