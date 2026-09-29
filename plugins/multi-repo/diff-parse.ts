/**
 * Parsers for git's `-z` porcelain output.
 *
 * Every one of these reads a NUL-delimited stream rather than lines, because
 * a path may legally contain a newline and the line-oriented forms of these
 * commands quote such a path instead of emitting it — which would mean
 * un-quoting C string escapes here and getting it subtly wrong. The `-z` forms
 * have no quoting at all.
 *
 * Pure, so the record-shape decisions below are testable without a repo.
 */
import type { ChangedFile } from "./contract.js";

export type ChangeStatus = ChangedFile["status"];

/** Split a NUL-delimited stream, dropping the trailing empty field. */
export function splitNul(value: string): string[] {
  const parts = value.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * Git's status letter → the five statuses the panel draws.
 *
 * `T` (type change, e.g. a file became a symlink) and `U` (unmerged) both
 * collapse to `modified`: the panel's job is to show the patch, and both have
 * one. A copy reads as an addition because that is what it is at the
 * destination.
 */
export function mapStatusLetter(letter: string): ChangeStatus {
  switch (letter[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "added";
    default:
      return "modified";
  }
}

/**
 * `git diff --name-status -z <base>`.
 *
 * Each record is a status field followed by one path, or — for `R`/`C`, which
 * carry a similarity score in the same field — two paths, source first.
 */
export function parseNameStatus(output: string): { path: string; oldPath: string | null; status: ChangeStatus }[] {
  const tokens = splitNul(output);
  const files: { path: string; oldPath: string | null; status: ChangeStatus }[] = [];
  let index = 0;
  while (index < tokens.length) {
    const letter = tokens[index];
    index += 1;
    if (letter === undefined || letter.length === 0) continue;
    const status = mapStatusLetter(letter);
    if (letter.startsWith("R") || letter.startsWith("C")) {
      const from = tokens[index];
      const to = tokens[index + 1];
      index += 2;
      if (from === undefined || to === undefined) break;
      files.push({ path: to, oldPath: from, status });
      continue;
    }
    const filePath = tokens[index];
    index += 1;
    if (filePath === undefined) break;
    files.push({ path: filePath, oldPath: null, status });
  }
  return files;
}

export interface NumstatEntry {
  path: string;
  /** Null for a binary file, which git reports as `-`. */
  additions: number | null;
  deletions: number | null;
}

/**
 * `git diff --numstat -z <base>`.
 *
 * The `-z` form is irregular: an ordinary record is one field
 * (`adds\tdels\tpath`), but a rename ends its first field after the second tab
 * and puts the two paths in the *next two* fields. Detecting that by "the path
 * part of the first field is empty" is what the git source itself does.
 */
export function parseNumstat(output: string): NumstatEntry[] {
  const tokens = splitNul(output);
  const entries: NumstatEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const field = tokens[index];
    index += 1;
    if (field === undefined || field.length === 0) continue;
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/u.exec(field);
    if (match === null) continue;
    const additions = match[1] === "-" ? null : Number.parseInt(match[1], 10);
    const deletions = match[2] === "-" ? null : Number.parseInt(match[2], 10);
    let filePath = match[3];
    if (filePath === "") {
      // Rename or copy: source then destination follow as separate fields.
      const destination = tokens[index + 1];
      index += 2;
      if (destination === undefined) break;
      filePath = destination;
    }
    entries.push({ path: filePath, additions, deletions });
  }
  return entries;
}

/** Join a name-status listing to its line counts, preserving git's order. */
export function mergeNumstat(
  files: readonly { path: string; oldPath: string | null; status: ChangeStatus }[],
  numstat: readonly NumstatEntry[],
): ChangedFile[] {
  const counts = new Map(numstat.map((entry) => [entry.path, entry]));
  return files.map((file) => {
    const entry = counts.get(file.path);
    return {
      path: file.path,
      status: file.status,
      oldPath: file.oldPath,
      additions: entry?.additions ?? null,
      deletions: entry?.deletions ?? null,
    };
  });
}

export interface PorcelainCounts {
  dirty: number;
  untracked: number;
}

/**
 * `git status --porcelain=v1 -z`.
 *
 * Each record is two status characters, a space, and the path; a rename adds
 * the source path as a following field. `??` is untracked and everything else
 * counts as a tracked change, staged or not — the panel shows one number for
 * "work in progress here", not a staging-area breakdown.
 */
export function parsePorcelainCounts(output: string): PorcelainCounts {
  const tokens = splitNul(output);
  let dirty = 0;
  let untracked = 0;
  let index = 0;
  while (index < tokens.length) {
    const record = tokens[index];
    index += 1;
    if (record === undefined || record.length < 3) continue;
    const code = record.slice(0, 2);
    if (code === "??") untracked += 1;
    else if (code !== "!!") dirty += 1;
    if (code[0] === "R" || code[0] === "C") index += 1;
  }
  return { dirty, untracked };
}

/** `git rev-list --left-right --count <base>...HEAD` → behind, then ahead. */
export function parseAheadBehind(output: string): { ahead: number; behind: number } {
  const match = /^(\d+)\s+(\d+)/u.exec(output.trim());
  if (match === null) return { ahead: 0, behind: 0 };
  return { behind: Number.parseInt(match[1], 10), ahead: Number.parseInt(match[2], 10) };
}

/**
 * Cut a patch at a byte budget on a line boundary.
 *
 * Mid-line would produce something the diff viewer parses as a corrupt hunk;
 * cutting whole lines degrades to a short but valid patch instead. The caller
 * tells the user it was cut — silently showing a partial diff as if it were
 * the whole thing is the one outcome worth avoiding.
 */
export function truncatePatch(patch: string, maxBytes: number): { patch: string; truncated: boolean } {
  if (Buffer.byteLength(patch, "utf8") <= maxBytes) return { patch, truncated: false };
  const buffer = Buffer.from(patch, "utf8").subarray(0, maxBytes);
  const text = buffer.toString("utf8");
  const lastBreak = text.lastIndexOf("\n");
  return { patch: lastBreak > 0 ? text.slice(0, lastBreak + 1) : text, truncated: true };
}
