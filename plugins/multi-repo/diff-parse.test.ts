import { describe, expect, it } from "vitest";
import {
  mapStatusLetter,
  mergeNumstat,
  parseAheadBehind,
  parseNameStatus,
  parseNumstat,
  parsePorcelainCounts,
  splitNul,
  truncatePatch,
} from "./diff-parse.js";

describe("parseNameStatus", () => {
  it("reads one path per ordinary record", () => {
    const files = parseNameStatus("M\0src/a.ts\0A\0src/b.ts\0D\0src/c.ts\0");
    expect(files).toEqual([
      { path: "src/a.ts", oldPath: null, status: "modified" },
      { path: "src/b.ts", oldPath: null, status: "added" },
      { path: "src/c.ts", oldPath: null, status: "deleted" },
    ]);
  });

  it("reads two paths for a rename, source first", () => {
    const files = parseNameStatus("R100\0old/a.ts\0new/a.ts\0");
    expect(files).toEqual([{ path: "new/a.ts", oldPath: "old/a.ts", status: "renamed" }]);
  });

  it("handles a path containing a newline, which is why -z exists", () => {
    const files = parseNameStatus("M\0we\nird.txt\0");
    expect(files).toEqual([{ path: "we\nird.txt", oldPath: null, status: "modified" }]);
  });

  it("stops cleanly on a truncated stream instead of emitting a half record", () => {
    expect(parseNameStatus("R100\0only-one-path\0")).toEqual([]);
  });

  it("maps type changes and unmerged entries to modified", () => {
    expect(mapStatusLetter("T")).toBe("modified");
    expect(mapStatusLetter("U")).toBe("modified");
    expect(mapStatusLetter("C75")).toBe("added");
  });

  it("returns nothing for empty output", () => {
    expect(parseNameStatus("")).toEqual([]);
  });
});

describe("parseNumstat", () => {
  it("reads counts for an ordinary record", () => {
    expect(parseNumstat("3\t1\tsrc/a.ts\0")).toEqual([{ path: "src/a.ts", additions: 3, deletions: 1 }]);
  });

  it("reports a binary file as null counts rather than zero", () => {
    // Zero would read as "no changes", which is the opposite of the truth.
    expect(parseNumstat("-\t-\timg.png\0")).toEqual([{ path: "img.png", additions: null, deletions: null }]);
  });

  it("reads the irregular rename form, where the paths are separate fields", () => {
    expect(parseNumstat("2\t0\t\0old.ts\0new.ts\0")).toEqual([{ path: "new.ts", additions: 2, deletions: 0 }]);
  });

  it("mixes rename and ordinary records in one stream", () => {
    const entries = parseNumstat("2\t0\t\0old.ts\0new.ts\0" + "5\t5\tother.ts\0");
    expect(entries.map((entry) => entry.path)).toEqual(["new.ts", "other.ts"]);
  });
});

describe("mergeNumstat", () => {
  it("joins counts onto the name-status listing and keeps git's order", () => {
    const merged = mergeNumstat(
      [
        { path: "b.ts", oldPath: null, status: "modified" },
        { path: "a.ts", oldPath: null, status: "added" },
      ],
      [{ path: "a.ts", additions: 1, deletions: 0 }],
    );
    expect(merged.map((file) => file.path)).toEqual(["b.ts", "a.ts"]);
    expect(merged[0].additions).toBeNull();
    expect(merged[1].additions).toBe(1);
  });
});

describe("parsePorcelainCounts", () => {
  it("separates untracked from tracked changes", () => {
    expect(parsePorcelainCounts("?? new.ts\0 M edited.ts\0M  staged.ts\0")).toEqual({ dirty: 2, untracked: 1 });
  });

  it("consumes the extra path a rename record carries", () => {
    // Without the skip, `old.ts` would be counted as a second change.
    expect(parsePorcelainCounts("R  new.ts\0old.ts\0")).toEqual({ dirty: 1, untracked: 0 });
  });

  it("ignores ignored files", () => {
    expect(parsePorcelainCounts("!! build/\0")).toEqual({ dirty: 0, untracked: 0 });
  });

  it("returns zeros for a clean tree", () => {
    expect(parsePorcelainCounts("")).toEqual({ dirty: 0, untracked: 0 });
  });
});

describe("parseAheadBehind", () => {
  it("reads git's left-right counts as behind then ahead", () => {
    expect(parseAheadBehind("2\t5\n")).toEqual({ behind: 2, ahead: 5 });
  });

  it("degrades to zeros on unexpected output", () => {
    expect(parseAheadBehind("")).toEqual({ behind: 0, ahead: 0 });
  });
});

describe("truncatePatch", () => {
  it("leaves a patch under the budget alone", () => {
    expect(truncatePatch("a\nb\n", 100)).toEqual({ patch: "a\nb\n", truncated: false });
  });

  it("cuts on a line boundary so the result still parses as a patch", () => {
    const patch = "line one\nline two\nline three\n";
    const cut = truncatePatch(patch, 12);
    expect(cut.truncated).toBe(true);
    expect(cut.patch.endsWith("\n")).toBe(true);
    expect(cut.patch).toBe("line one\n");
  });

  it("does not exceed the budget even with multi-byte characters", () => {
    const patch = "é".repeat(100);
    const cut = truncatePatch(patch, 20);
    expect(Buffer.byteLength(cut.patch, "utf8")).toBeLessThanOrEqual(20);
    expect(cut.truncated).toBe(true);
  });
});

describe("splitNul", () => {
  it("drops the trailing empty field git always emits", () => {
    expect(splitNul("a\0b\0")).toEqual(["a", "b"]);
    expect(splitNul("")).toEqual([]);
  });
});
