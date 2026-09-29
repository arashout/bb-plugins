/**
 * Path safety for every name this plugin takes from outside itself.
 *
 * Three different untrusted strings end up as path segments: a `dir` from
 * `repos.json` (which a user edits by hand and an agent edits through a tool),
 * a `pathKey` from core, and a cache key derived from a repo URL. All three are
 * joined onto a directory this plugin owns, so all three are checked here
 * rather than at each call site — a single `..` that slipped through would let
 * a repo entry write outside the workspace root.
 *
 * Pure: no `node:fs`, so the server bundle and the tests can import it too.
 */
import { createHash } from "node:crypto";

export class MultiRepoPathError extends Error {}

/**
 * A single path segment, safe on every platform bb runs on.
 *
 * Rejects separators in both directions (a `\` is a separator on Windows and
 * an ordinary character on Linux, so a name carrying one is never intended),
 * the two dot segments, leading dots (which would shadow `.bb` or `.git`),
 * NUL, and anything long enough to be a filesystem argument rather than a
 * name.
 */
export function isSafeSegment(value: string): boolean {
  if (value.length === 0 || value.length > 100) return false;
  if (value === "." || value === "..") return false;
  if (value.startsWith(".")) return false;
  if (value.includes("/") || value.includes("\\")) return false;
  if (value.includes("\0")) return false;
  // A trailing dot or space is silently trimmed by Windows, so two entries
  // that differ only there would collide on one machine and not another.
  if (value !== value.trim() || value.endsWith(".")) return false;
  return true;
}

export function assertSafeSegment(value: string, what: string): string {
  if (!isSafeSegment(value)) {
    throw new MultiRepoPathError(
      `${what} must be a plain directory name without separators or dot segments: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * The `.bb` directory name, which is the one segment a repo may not claim:
 * bb itself reads `<workspace>/.bb/AGENTS.md` and `<workspace>/.bb/skills`, so
 * a repo cloned there would replace the project's own guidance.
 *
 * `isSafeSegment` already rejects it for leading-dot reasons; the constant
 * exists so the error message can say why rather than describing dots.
 */
export const PROJECT_SOURCE_DIR = ".bb";

/**
 * A stable cache directory name for a repo URL.
 *
 * The readable prefix is for a human reading `ls` on the cache; the hash is
 * what makes it unique. Two repos with the same basename (`you/bb` and
 * `them/bb`) must not share an object store, and a URL is not itself a legal
 * directory name, so neither half works alone.
 */
export function cacheKeyForUrl(url: string): string {
  const digest = createHash("sha256").update(normalizeRemoteUrl(url)).digest("hex").slice(0, 12);
  const slug = (url.replace(/\.git$/u, "").split(/[/:]/u).pop() ?? "repo")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .slice(0, 40);
  return `${slug.length > 0 ? slug : "repo"}-${digest}`;
}

/**
 * The comparison form of a remote URL, for "is this checkout a mirror of that
 * repo" and for keying the cache.
 *
 * Git accepts the same GitHub repo as `git@github.com:you/r.git`,
 * `ssh://git@github.com/you/r`, and `https://github.com/you/r/` — treating
 * those as three repos would mean three cache entries and a missed local
 * mirror, so they are folded to one. Nothing here rewrites the URL that is
 * actually handed to git; this form is only ever compared.
 */
export function normalizeRemoteUrl(url: string): string {
  let value = url.trim().replace(/\/+$/u, "");
  value = value.replace(/\.git$/u, "");
  // scp-style `user@host:path` → `ssh://user@host/path`, so one parse covers both.
  const scp = /^([^/@]+@)?([^/:]+):(?!\/)(.+)$/u.exec(value);
  if (scp !== null && !value.includes("://")) {
    value = `ssh://${scp[1] ?? ""}${scp[2]}/${scp[3]}`;
  }
  const withScheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?(.+)$/iu.exec(value);
  if (withScheme !== null) {
    // The scheme and any credentials are transport, not identity: the same
    // repo over ssh and https is the same repo.
    return withScheme[2].toLowerCase();
  }
  return value;
}
