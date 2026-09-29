import { describe, expect, it } from "vitest";
import { MAX_THREAD_PRS, suggestEfforts, type ClassifyInput, type ClassifyPr } from "./effort-classify.js";

const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
const pr = (repo: string, number: number, title: string, headRefName: string, extra: Partial<ClassifyPr> = {}): ClassifyPr =>
  ({ url: url(repo, number), repo: `inkwell/${repo}`, number, title, headRefName, baseRefName: "main", effortId: null, areas: [], ...extra });

/**
 * The real mix, in Inkwell words: most PRs name no ticket in the title, branches carry lowercase keys, stacks hang off owned and
 * unowned PRs, one housekeeping thread links many PRs, and one theme shows only in code areas or the board's own groups.
 */
function inkwell(): ClassifyInput {
  const owned = [
    pr("spine", 150, "ABC-330 Reserve books for store pickup", "abc-330-reserve", { effortId: "pickup" }),
    pr("spine", 151, "ABC-331 Notify readers when holds arrive", "abc-331-notify", { effortId: "pickup" }),
    pr("atlas", 405, "Let readers update their email", "abc-205-email", { effortId: "accounts" }),
    pr("atlas", 406, "Confirm email changes by link", "reader/confirm-email", { effortId: "accounts" }),
    pr("folio", 311, "Rotate vault audit keys", "ops-41-keys", { effortId: "vault" }),
    pr("folio", 312, "Record vault access reviews", "ops-42-reviews", { effortId: "vault" }),
    pr("catalog", 95, "Sort series by publication order", "series-order", { effortId: "search", areas: ["inkwell/catalog:search/ranking"] }),
    pr("folio", 314, "Group shelves by genre", "shelf-genre", { effortId: "shelf" }),
    // Owned by an effort that is done, so it points nowhere.
    pr("quill", 300, "Export notes as EPUB", "abc-900-epub", { effortId: "export-done" }),
  ];
  const loose = [
    pr("spine", 152, "Expire unclaimed holds", "reader/abc-331-expire"),
    pr("spine", 153, "Show pickup hours per store", "reader/pickup-hours", { baseRefName: "reader/abc-331-expire" }),
    pr("atlas", 410, "Keep email in sync after sign-in", "reader/email-sync", { baseRefName: "reader/confirm-email" }),
    pr("quill", 209, "Log vault token use", "ops-43-token-log"),
    pr("catalog", 101, "Rerank by availability", "rerank", { areas: ["inkwell/catalog:search/ranking", "inkwell/catalog:."] }),
    pr("folio", 420, "Gift card balance page", "abc-801-balance"),
    pr("quill", 220, "Gift card receipts", "abc-801-receipts"),
    pr("atlas", 420, "Batch shelf sync", "shelf-sync-batch"),
    pr("atlas", 421, "Retry shelf sync on conflict", "shelf-sync-retry", { baseRefName: "shelf-sync-batch" }),
    pr("folio", 430, "Count reading streak days", "streak-count"),
    pr("folio", 431, "Reset streaks at midnight", "streak-reset"),
    pr("folio", 440, "Show page counts on book cards", "abc-879-page-counts"),
    pr("folio", 441, "Tidy reader settings", "wip"),
    pr("folio", 442, "Keep UTF-8 author names", "utf-8-names"),
    pr("catalog", 102, "Tidy stale labels", "tidy-labels"),
    pr("folio", 450, "Shelf drag handles", "shelf-drag"),
    pr("folio", 461, "Fix email change copy", "abc-205-copy"),
    pr("folio", 462, "Shared toolbar", "toolbar"),
    pr("quill", 301, "EPUB cover images", "abc-900-covers"),
  ];
  return {
    prs: [...owned, ...loose],
    efforts: [{ id: "pickup", name: "Store pickup", tickets: ["ABC-330"] }, { id: "accounts", name: "Reader accounts", tickets: [] },
      { id: "vault", name: "Vault audits", tickets: [] }, { id: "search", name: "Catalog search", tickets: [] }, { id: "shelf", name: "Shelf order", tickets: [] }],
    groups: [{ key: "Reading streaks", name: "Reading streaks", prUrls: [url("folio", 430), url("folio", 431)] }],
    threads: [
      // A housekeeping thread that touched Store pickup's PRs while it tidied an unrelated one.
      { id: "thr-tidy", title: "Weekly tidy-up", prUrls: [url("catalog", 102), url("spine", 150), url("spine", 151), url("spine", 152), url("spine", 153)] },
      { id: "thr-shelf", title: "Shelf work", prUrls: [url("folio", 450), url("folio", 314)] },
      { id: "thr-pickup", title: "Pickup pairing", prUrls: [url("folio", 461), url("spine", 150)] },
      { id: "thr-toolbar-a", title: "Toolbar spike", prUrls: [url("folio", 462), url("spine", 151)] },
      { id: "thr-toolbar-b", title: "Toolbar polish", prUrls: [url("folio", 462), url("folio", 314)] },
    ],
    ticketTitles: new Map([["ABC-801", "Gift cards"]]),
    // Uppercase only: suggestions must still read the lowercase keys branches carry.
    pattern: /([A-Z]{2,5})-(\d{1,6})/u,
  };
}

const summary = (input: ClassifyInput) => suggestEfforts(input).map((group) => [group.target?.kind === "effort" ? group.target.name : group.target?.kind === "new"
  ? `new: ${group.target.name}` : group.target?.kind ?? null, group.confidence, group.prs.map((row) => `${row.repo.split("/")[1]} #${row.number}`)]);

describe("effort suggestions", () => {
  it("sorts the Inkwell mix into efforts, new efforts, and one-offs, strongest first, with the rest left to pick", () => {
    expect(summary(inkwell())).toEqual([
      ["Store pickup", "high", ["spine #152", "spine #153"]],
      ["Reader accounts", "high", ["atlas #410"]],
      ["new: Gift cards (ABC-801)", "medium", ["folio #420", "quill #220"]],
      ["new: Batch shelf sync", "medium", ["atlas #420", "atlas #421"]],
      ["Shelf order", "medium", ["folio #450"]],
      ["new: Reading streaks", "low", ["folio #430", "folio #431"]],
      // Its own group: accepting Reader accounts' high group never carries a PR whose signals disagree.
      ["Reader accounts", "low", ["folio #461"]],
      ["Catalog search", "low", ["catalog #101"]],
      ["Vault audits", "low", ["quill #209"]],
      ["one-off", "low", ["folio #440"]],
      [null, null, ["catalog #102", "folio #441", "folio #442", "folio #462", "quill #301"]],
    ]);
  });

  it("reads a lowercase ticket in a branch as the ticket an effort's PR names in its title", () => {
    const group = suggestEfforts(inkwell()).find((candidate) => candidate.key === "effort:pickup:high")!;
    expect(group.reason).toBe("Shared ticket");
    expect(group.prs.find((row) => row.number === 152)!.signals).toEqual([{ kind: "ticket", effortId: "pickup", text: "ticket ABC-331" }]);
  });

  it("files a stacked PR with its base: in the base's effort, or beside a base that is still to sort", () => {
    const groups = suggestEfforts(inkwell());
    expect(groups.find((group) => group.key === "effort:accounts:high")!.prs).toEqual([{ prUrl: url("atlas", 410), repo: "inkwell/atlas", number: 410,
      title: "Keep email in sync after sign-in", signals: [{ kind: "stack", effortId: "accounts", text: "stacked on atlas #406" }] }]);
    // #153 carries no signal of its own; it rides with #152, whose head it builds on.
    expect(groups.find((group) => group.key === "effort:pickup:high")!.prs.find((row) => row.number === 153)!.signals).toEqual([]);
  });

  it("ignores a thread that links more PRs than one piece of work would", () => {
    const input = inkwell();
    expect(input.threads[0]!.prUrls.length).toBeGreaterThan(MAX_THREAD_PRS);
    expect(suggestEfforts(input).find((group) => group.target === null)!.prs.map((row) => row.number)).toContain(102);
    const focused = { ...input, threads: [{ id: "thr-tidy", title: "Weekly tidy-up", prUrls: [url("catalog", 102), url("folio", 314)] }] };
    expect(suggestEfforts(focused).find((group) => group.prs.some((row) => row.number === 102))).toMatchObject({ key: "effort:shelf:medium", reason: "Linked thread" });
  });

  it("lets a shared ticket outweigh a thread that disagrees, at low confidence, and suggests nothing on a tie", () => {
    const groups = suggestEfforts(inkwell());
    expect(groups.find((group) => group.key === "effort:accounts:low")!.prs[0]!.signals).toEqual([
      { kind: "ticket", effortId: "accounts", text: "ticket ABC-205" }, { kind: "thread", effortId: "pickup", text: "thread “Pickup pairing”" }]);
    expect(groups.find((group) => group.target === null)!.prs.find((row) => row.number === 462)!.signals).toEqual([
      { kind: "thread", effortId: "pickup", text: "thread “Toolbar spike”" }, { kind: "thread", effortId: "shelf", text: "thread “Toolbar polish”" }]);
  });

  // Done efforts and One-offs aren't in `efforts`: a PR they own says nothing, and a ticket it shares isn't standalone either.
  it("never points at an effort you can't add to, and calls a PR standalone only when nothing else carries its ticket", () => {
    const groups = suggestEfforts(inkwell());
    expect(groups.find((group) => group.target === null)!.prs.find((row) => row.number === 301)!.signals).toEqual([]);
    // UTF-8 matches the ticket pattern, but no other work uses a UTF prefix, so it isn't a ticket that makes #442 standalone.
    expect(groups.find((group) => group.target === null)!.prs.map((row) => row.number)).toContain(442);
    expect(groups.find((group) => group.key === "one-off")).toMatchObject({ reason: "Standalone ticket that nothing else carries", tickets: ["ABC-879"],
      prs: [{ number: 440, signals: [{ kind: "ticket", effortId: null, text: "ticket ABC-879" }] }] });
  });

  it("names a proposed effort from Linear, or its board group, or its first PR, and offers the tickets that tie it", () => {
    const groups = suggestEfforts(inkwell());
    expect(groups.find((group) => group.target?.kind === "new" && group.target.name === "Gift cards (ABC-801)")).toMatchObject({ key: "new:ABC-801",
      reason: "Shared ticket ABC-801, no effort yet", tickets: ["ABC-801"], prs: [{ signals: [{ kind: "ticket", effortId: null, text: "ticket ABC-801" }] }, {}] });
    expect(groups.find((group) => group.key === "new:Reading streaks")).toMatchObject({ reason: "Board group, no effort yet", tickets: [] });
    expect(groups.find((group) => group.target?.kind === "new" && group.target.name === "Batch shelf sync")).toMatchObject({ reason: "Stacked PRs, no effort yet",
      prs: [{ number: 420, signals: [] }, { number: 421, signals: [{ kind: "stack", effortId: null, text: "stacked on atlas #420" }] }] });
  });
});
