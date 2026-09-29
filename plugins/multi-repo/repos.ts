/**
 * `repos.json` — the repo set, and the only source of truth for it.
 *
 * The file lives in the project's `.bb` git repo. This plugin reads it, edits
 * it, and commits it; it never keeps a second copy that could disagree. Plugin
 * storage holds derived state only (cache freshness, workspace manifests, the
 * precomputed layout), all of which is rebuildable from this file.
 *
 * It sits on the critical path for every thread creation in the project, so
 * every failure here names the offending entry. A file that does not parse is
 * a failed environment with a message a person can act on, not a silently
 * empty workspace.
 *
 * Pure: schema, validation, and the edits the tools and the panel perform. No
 * filesystem, no git — the caller owns both ends.
 */
import { z } from "zod";
import { PROJECT_SOURCE_DIR, isSafeSegment, normalizeRemoteUrl } from "./paths.js";

export const REPOS_FILE = "repos.json";
export const REPOS_VERSION = 1;

/**
 * How many repos one workspace may hold.
 *
 * Not a technical limit — a cold start clones every one of them, and the
 * layout block the agent reads has a 4096-character ceiling. Both degrade
 * badly and quietly past a few dozen, so the file says no with a message
 * instead.
 */
export const MAX_REPOS = 32;

export const repoEntrySchema = z
  .object({
    dir: z.string().min(1).max(100),
    url: z.string().min(1).max(2000),
    branch: z.string().min(1).max(300).optional(),
  })
  .strict();

export type RepoEntry = z.infer<typeof repoEntrySchema>;

export const reposFileSchema = z
  .object({
    version: z.literal(REPOS_VERSION),
    repos: z.array(repoEntrySchema).max(MAX_REPOS),
  })
  .strict();

export type ReposFile = z.infer<typeof reposFileSchema>;

export const EMPTY_REPOS: ReposFile = { version: REPOS_VERSION, repos: [] };

export type ParseResult =
  | { ok: true; value: ReposFile }
  | { ok: false; error: string };

/** A zod issue path rendered the way a person reads the file: `repos[0].dir`. */
function issueLocation(path: readonly PropertyKey[]): string {
  let text = "";
  for (const segment of path) {
    if (typeof segment === "number") text += `[${segment}]`;
    else text += text === "" ? String(segment) : `.${String(segment)}`;
  }
  return text === "" ? "(root)" : text;
}

/**
 * Parse and fully validate the file's text.
 *
 * Strict JSON on purpose: documentation lives in the seeded `AGENTS.md` and
 * the plugin panel, not in comments nobody can parse back out. The semantic
 * rules below (safe directory names, no duplicates, `.bb` reserved) are not
 * expressible in the schema and matter more than the shape does — a duplicate
 * `dir` is the one mistake that silently loses a repo.
 */
export function parseReposFile(text: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: `${REPOS_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = reposFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `${REPOS_FILE} is invalid at ${issueLocation(issue.path)}: ${issue.message}`,
    };
  }
  const semantic = validateRepoSet(parsed.data.repos);
  if (semantic !== null) return { ok: false, error: semantic };
  return { ok: true, value: parsed.data };
}

/** The rules the schema cannot state. Returns the first failure, or null. */
export function validateRepoSet(repos: readonly RepoEntry[]): string | null {
  const seenDirs = new Set<string>();
  const seenUrls = new Map<string, string>();
  for (const [index, repo] of repos.entries()) {
    const at = `${REPOS_FILE} repos[${index}]`;
    if (repo.dir === PROJECT_SOURCE_DIR) {
      return `${at}: "${PROJECT_SOURCE_DIR}" is reserved for the project's own workspace definition.`;
    }
    if (!isSafeSegment(repo.dir)) {
      return `${at}: dir ${JSON.stringify(repo.dir)} must be a plain directory name — no separators, dot segments, or leading dots.`;
    }
    // Case-insensitively, because macOS and Windows would collapse two entries
    // that Linux keeps apart, and a repo set should mean the same thing on
    // every machine in the project.
    const dirKey = repo.dir.toLowerCase();
    if (seenDirs.has(dirKey)) return `${at}: dir ${JSON.stringify(repo.dir)} is already used by an earlier entry.`;
    seenDirs.add(dirKey);
    if (repo.url.includes("\0") || repo.url.trim() !== repo.url) {
      return `${at}: url ${JSON.stringify(repo.url)} has leading, trailing, or embedded control characters.`;
    }
    // A URL beginning with `-` would be read by git as an option rather than a
    // location. Every git call here passes arguments as an array, so nothing
    // is shell-parsed, but `git clone --upload-pack=…` is still an argument.
    if (repo.url.startsWith("-")) return `${at}: url ${JSON.stringify(repo.url)} may not start with "-".`;
    const urlKey = normalizeRemoteUrl(repo.url);
    const clash = seenUrls.get(urlKey);
    if (clash !== undefined) {
      // Not fatal in principle — two checkouts of one repo is a legal thing to
      // want — but it is far more often a copy-paste mistake, and the cost of
      // being wrong is a second full clone of the same code.
      return `${at}: url ${JSON.stringify(repo.url)} is the same repo as "${clash}". Remove one, or give them different remotes.`;
    }
    seenUrls.set(urlKey, repo.dir);
  }
  return null;
}

/**
 * Serialize for committing.
 *
 * Two spaces and a trailing newline, always in the same key order, so the
 * plugin's own edits produce a one-line diff a person can review rather than
 * reformatting the whole file underneath them.
 */
export function serializeReposFile(file: ReposFile): string {
  const repos = file.repos.map((repo) => ({
    dir: repo.dir,
    url: repo.url,
    ...(repo.branch === undefined ? {} : { branch: repo.branch }),
  }));
  return `${JSON.stringify({ version: REPOS_VERSION, repos }, null, 2)}\n`;
}

export type EditResult =
  | { ok: true; value: ReposFile }
  | { ok: false; error: string };

/**
 * The directory name a repo gets when the caller did not pick one: the URL's
 * last component, minus `.git`.
 *
 * Returns null rather than a fallback when nothing usable comes out, so
 * `workspace_add_repo` asks for an explicit `dir` instead of inventing
 * `repo-1` and leaving the agent to discover what it got.
 */
export function dirFromUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/u, "").replace(/\.git$/u, "");
  const candidate = trimmed.split(/[/:\\]/u).pop() ?? "";
  return isSafeSegment(candidate) ? candidate : null;
}

export function addRepo(file: ReposFile, entry: RepoEntry): EditResult {
  if (file.repos.length >= MAX_REPOS) {
    return { ok: false, error: `A workspace may hold at most ${MAX_REPOS} repos.` };
  }
  const next: ReposFile = { version: REPOS_VERSION, repos: [...file.repos, entry] };
  const problem = validateRepoSet(next.repos);
  return problem === null ? { ok: true, value: next } : { ok: false, error: problem };
}

export function removeRepo(file: ReposFile, dir: string): EditResult {
  const repos = file.repos.filter((repo) => repo.dir !== dir);
  if (repos.length === file.repos.length) {
    return { ok: false, error: `No repo named ${JSON.stringify(dir)} is in ${REPOS_FILE}.` };
  }
  return { ok: true, value: { version: REPOS_VERSION, repos } };
}

/** Whether a repo with this directory name — or this remote — is already in the set. */
export function findRepo(file: ReposFile, entry: { dir?: string; url?: string }): RepoEntry | null {
  const url = entry.url === undefined ? null : normalizeRemoteUrl(entry.url);
  return (
    file.repos.find(
      (repo) =>
        (entry.dir !== undefined && repo.dir === entry.dir) ||
        (url !== null && normalizeRemoteUrl(repo.url) === url),
    ) ?? null
  );
}
