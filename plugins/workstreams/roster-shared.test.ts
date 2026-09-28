import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EFFECTS } from "./effort-command.js";
import { EFFECT_LABEL, formatTargets } from "./roster-shared.js";

const url = "https://github.com/inkwell/quill/pull/93";

describe("roster-shared", () => {
  it("imports nothing, so the browser bundle can use it without reaching a server module", () => {
    const source = readFileSync(new URL("./roster-shared.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\b/mu);
    expect(source).not.toMatch(/^\s*export\s[^;]*\sfrom\s/mu);
  });

  it("writes numbers as the runs a command reads back, then unnumbered PRs", () => {
    const numbered = [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((n) => ({ target: `t${n}`, n }));
    expect(formatTargets(numbered)).toBe("1, 2, 4-17");
    expect(formatTargets([{ target: "b", n: 10 }, { target: "a", n: 9 }, { target: "a", n: 9 }])).toBe("9, 10");
    expect(formatTargets([{ target: url, n: null }, { target: "c", n: 3 }, { target: url, n: null }])).toBe(`3, ${url}`);
  });

  it("names every effect an instruction can grant, so the pane and the thread's acknowledgment use the same words for it", () => {
    expect(Object.keys(EFFECT_LABEL).sort()).toEqual([...EFFECTS].sort());
  });
});
