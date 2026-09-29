import { describe, expect, it } from "vitest";
import { assertSafeSegment, cacheKeyForUrl, isSafeSegment, normalizeRemoteUrl } from "./paths.js";

describe("isSafeSegment", () => {
  it("accepts ordinary directory names", () => {
    for (const name of ["bb-dylan", "repo_2", "a.b", "Repo"]) expect(isSafeSegment(name)).toBe(true);
  });

  it("rejects anything that could escape the workspace", () => {
    for (const name of ["", ".", "..", "a/b", "a\\b", "/abs", "a\0b"]) {
      expect(isSafeSegment(name)).toBe(false);
    }
  });

  it("rejects a leading dot, which would shadow .bb or .git", () => {
    expect(isSafeSegment(".bb")).toBe(false);
    expect(isSafeSegment(".git")).toBe(false);
  });

  it("rejects names Windows would silently trim into a collision", () => {
    expect(isSafeSegment("repo ")).toBe(false);
    expect(isSafeSegment("repo.")).toBe(false);
  });

  it("assertSafeSegment names what was wrong", () => {
    expect(() => assertSafeSegment("../x", "A repo directory name")).toThrow(/A repo directory name/u);
  });
});

describe("normalizeRemoteUrl", () => {
  it("folds the spellings of one GitHub repo together", () => {
    const forms = [
      "git@github.com:you/repo.git",
      "ssh://git@github.com/you/repo",
      "https://github.com/you/repo/",
      "https://github.com/you/repo.git",
    ];
    const normalized = new Set(forms.map(normalizeRemoteUrl));
    expect(normalized.size).toBe(1);
    expect([...normalized][0]).toBe("github.com/you/repo");
  });

  it("keeps different repos apart", () => {
    expect(normalizeRemoteUrl("https://github.com/you/a")).not.toBe(normalizeRemoteUrl("https://github.com/them/a"));
  });

  it("leaves a local path alone apart from trailing slashes", () => {
    expect(normalizeRemoteUrl("/home/me/src/repo/")).toBe("/home/me/src/repo");
  });

  it("does not mistake a Windows drive path for an scp-style remote", () => {
    // `C:\src\repo` has the shape `host:path`, but it is a local path.
    expect(normalizeRemoteUrl("C:\\src\\repo")).toContain("src");
  });
});

describe("cacheKeyForUrl", () => {
  it("is stable across equivalent spellings", () => {
    expect(cacheKeyForUrl("git@github.com:you/repo.git")).toBe(cacheKeyForUrl("https://github.com/you/repo"));
  });

  it("separates two repos that share a basename", () => {
    // The readable prefix collides on purpose; the hash is what keeps two
    // orgs' `bb` from sharing one object store.
    const a = cacheKeyForUrl("https://github.com/you/bb");
    const b = cacheKeyForUrl("https://github.com/them/bb");
    expect(a).not.toBe(b);
    expect(a.startsWith("bb-")).toBe(true);
    expect(b.startsWith("bb-")).toBe(true);
  });

  it("produces a legal directory name from a hostile url", () => {
    const key = cacheKeyForUrl("https://example.com/../weird name/../repo?x=1");
    expect(isSafeSegment(key)).toBe(true);
  });
});
