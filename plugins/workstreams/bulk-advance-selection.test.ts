import { describe, expect, it } from "vitest";
import { ADVANCE_SELECTION_LIMIT, clearVisibleSelection, eligibleAdvanceSelection, reconcileAdvanceSelection, selectVisibleOpen } from "./bulk-advance-selection";

const approved = (n: number) => ({ url: `https://github.com/acme/app/pull/${n}`, state: "OPEN", reviewDecision: "APPROVED" });

describe("finite advance selection", () => {
  it("selects open PRs regardless of approval while preserving choices outside the current search", () => {
    const draft = { ...approved(5), reviewDecision: null, isDraft: true };
    const selected = selectVisibleOpen([approved(1).url], [approved(2), { ...approved(3), reviewDecision: "CHANGES_REQUESTED" }, { ...approved(4), state: "MERGED" }, draft]);
    expect(selected).toEqual([approved(1).url, approved(2).url, approved(3).url, draft.url]);
  });
  it("selects only this section's eligible visible PRs and clears only this section", () => {
    const otherSection = approved(1).url;
    const hiddenBySearch = approved(2).url;
    const visibleSection = [approved(3), approved(4), { ...approved(5), reviewDecision: null }];
    const selected = selectVisibleOpen([otherSection, hiddenBySearch], visibleSection);
    expect(selected).toEqual([otherSection, hiddenBySearch, approved(3).url, approved(4).url, approved(5).url]);
    expect(clearVisibleSelection(selected, visibleSection)).toEqual([otherSection, hiddenBySearch]);
  });
  it("keeps previous sections selected when this section reaches the global limit", () => {
    const existing = Array.from({ length: ADVANCE_SELECTION_LIMIT - 1 }, (_, index) => approved(index + 1).url);
    const selected = selectVisibleOpen(existing, [approved(101), approved(102)]);
    expect(selected).toEqual([...existing, approved(101).url]);
    expect(clearVisibleSelection(selected, [approved(101)])).toEqual(existing);
  });
  it("drops closed PRs but retains selected PRs whose approval changed", () => {
    const selected = eligibleAdvanceSelection([approved(1).url, approved(2).url, approved(3).url], [approved(1), { ...approved(2), state: "CLOSED" }, { ...approved(3), reviewDecision: null }, approved(4)]);
    expect(selected).toEqual([approved(1).url, approved(3).url]);
  });
  it("requires a fresh selection when a closed PR reopens", () => {
    const initial = { urls: [approved(1).url, approved(2).url], removed: 0 };
    const afterPush = reconcileAdvanceSelection(initial, [approved(1), { ...approved(2), state: "CLOSED" }]);
    expect(afterPush).toEqual({ urls: [approved(1).url], removed: 1 });
    const reopened = reconcileAdvanceSelection(afterPush, [approved(1), approved(2)]);
    expect(reopened).toBe(afterPush);
  });
  it("deduplicates inventory and checkout URLs and respects the preview limit", () => {
    const prs = Array.from({ length: ADVANCE_SELECTION_LIMIT + 2 }, (_, index) => approved(index + 1));
    const selected = selectVisibleOpen([`${approved(1).url.toUpperCase()}/`], prs);
    expect(selected).toHaveLength(ADVANCE_SELECTION_LIMIT);
    expect(selected[0]).toBe(approved(1).url);
    expect(new Set(selected).size).toBe(selected.length);
  });
});

it("excludes held PRs from every selection and requires a fresh choice after release", () => {
  const prs = [approved(1), approved(2)];
  const holds = { [approved(1).url]: { reason: "Product approval", heldAt: 1 } };
  expect(selectVisibleOpen([], prs, holds)).toEqual([approved(2).url]);
  const selected = { urls: [`${approved(1).url.toUpperCase()}/`, approved(2).url], removed: 0 };
  expect(eligibleAdvanceSelection(selected.urls, prs, holds)).toEqual([approved(2).url]);
  const held = reconcileAdvanceSelection(selected, prs, holds);
  expect(held).toEqual({ urls: [approved(2).url], removed: 1 });
  expect(reconcileAdvanceSelection(held, prs, {})).toBe(held);
});
