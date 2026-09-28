import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// This repository is public, so the list of client repository names and ticket
// prefixes lives outside it. Pass the terms comma- or newline-separated.
const denylist = (process.env.WORKSTREAMS_PRIVATE_DENYLIST ?? "").split(/[,\n]/u).map((term) => term.trim()).filter(Boolean);
const root = fileURLToPath(new URL(".", import.meta.url));

// Case-insensitive, bounded only at letter or digit edges: `ink` never flags
// `inkwell`, while a prefix such as `XYZ-` still flags `xyz-12`.
function termPattern(term: string): RegExp {
  const alnum = (char: string) => /[\p{L}\p{N}]/u.test(char);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${alnum(term[0]!) ? "(?<![\\p{L}\\p{N}])" : ""}${escaped}${alnum(term.at(-1)!) ? "(?![\\p{L}\\p{N}])" : ""}`, "iu");
}

function pluginFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist", ".claude"].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? pluginFiles(path) : [path];
  });
}

describe("public plugin tree", () => {
  it("flags whole terms and ticket prefixes in any case, but not longer words", () => {
    expect(termPattern("ink").test("Ink and paper")).toBe(true);
    expect(termPattern("ink").test("inkwell/folio")).toBe(false);
    expect(termPattern("XYZ-").test("branch xyz-12-totals")).toBe(true);
    expect(termPattern("XYZ-").test("abcxyz-12")).toBe(false);
  });
  it.skipIf(denylist.length === 0)("names no client repository or ticket prefix (skipped unless WORKSTREAMS_PRIVATE_DENYLIST is set)", () => {
    const patterns = denylist.map(termPattern);
    const files = pluginFiles(root);
    expect(files).toContain(join(root, "howto.tsx"));
    // Report locations only, so a CI log never repeats the private terms.
    const hits = files.flatMap((path) => readFileSync(path, "utf8").split("\n")
      .flatMap((line, index) => patterns.some((pattern) => pattern.test(line)) ? [`${relative(root, path)}:${index + 1}`] : []));
    expect(hits).toEqual([]);
  });
});
