// The words the roster pane, the CLI, and the server's rollup share. This
// module imports nothing, so the browser bundle can use it without reaching a
// server module (plan amendment A12.1): effort-command.ts, for one, pulls in
// node:crypto through its GitHub helpers.

/** Realtime: the server publishes `{ effortId }`, or `{ effortId, prUrl }` for one refreshed row, whenever a roster changes. */
export const ROSTER_CHANGED = "effort-roster-changed";

/** A numbered roster PR, or one only its URL names. */
export type TargetRef = { target: string; n: number | null };

/** Numbers as runs ("1, 2, 4-17"), in the grammar a command reads back, then the URLs of unnumbered targets. */
export function formatTargets(targets: readonly TargetRef[]): string {
  const numbers = [...new Set(targets.flatMap((target) => target.n === null ? [] : [target.n]))].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < numbers.length; i++) {
    let j = i;
    while (numbers[j + 1] === numbers[j]! + 1) j++;
    runs.push(j - i >= 2 ? `${numbers[i]}-${numbers[j]}` : numbers.slice(i, j + 1).join(", "));
    i = j;
  }
  const urls = [...new Set(targets.filter((target) => target.n === null).map((target) => target.target))];
  return [...runs, ...urls].join(", ");
}

/** Each roster row state, as a row names it. */
export const STATE_LABEL = { doing: "Doing", waiting: "Waiting", decision: "Decision", ready: "Ready", issue: "System issue", done: "Done",
  "not-in-instruction": "Not in instruction" } as const;

/** The rollup's four lines, in order; the server writes each as `<label>: <text>`. */
export const ROLLUP_LABELS = ["Outcome", "Validated", "Still needed", "Needs a decision"] as const;
