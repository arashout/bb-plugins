// Address selected with no listing: one click plans one batch thread and starts it into the Undo window, and every way it can start
// nothing comes back in the server's words for the selection bar and the rows. Every name here is synthetic.
import { describe, expect, it } from "vitest";
import { addressToast, oneAtATime, sendingText, startAddress, workingLabel, type Working } from "./deck-flow.js";

const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const held = { prUrl: url(45), ref: "folio #45", reason: "On hold. Release it first." };
/** The two RPCs Address makes, answering as told and recording each call. */
function fake(plan: unknown, start: unknown = { ok: true, dispatchAt: 8_000 }) {
  const calls: string[] = [];
  const answer = (value: unknown) => value instanceof Error ? Promise.reject(value) : Promise.resolve(value as never);
  return { calls, rpc: { plan: (input: { kind: string; prUrls: string[] }) => { calls.push(`plan ${input.kind} ${input.prUrls.length}`); return answer(plan); },
    start: (batchId: string) => { calls.push(`start ${batchId}`); return answer(start); } } };
}

describe("Address selected", () => {
  // Reviews' flow: select, one click, one thread starts. The thread does any GitHub work, and dispatch checks every PR again first.
  it("plans and starts at once with no listing between, and says what it left out beside Undo", async () => {
    const { calls, rpc } = fake({ ok: true, batchId: "b-1", items: [{}, {}], skipped: [held] });
    const outcome = await startAddress(rpc, null, [42, 43, 45].map(url), {});
    expect(calls).toEqual(["plan address 3", "start b-1"]);
    expect(outcome).toEqual({ ok: true, batchId: "b-1", dispatchAt: 8_000, count: 2, skipped: [held] });
    expect(addressToast(outcome as Extract<typeof outcome, { ok: true }>)).toBe("Addressing 2 PRs in one thread · left out folio #45: On hold. Release it first.");
    expect(addressToast({ ok: true, batchId: "b-2", dispatchAt: 0, count: 1, skipped: [] })).toBe("Addressing 1 PR in one thread");
  });

  // Each way it starts nothing names why, and starts nothing after it.
  it("returns the server's reason when the plan is refused, fails, leaves every PR out, or its start is refused", async () => {
    const refused = fake({ ok: false, error: "Resume or reopen this effort first." });
    expect(await startAddress(refused.rpc, "effort-1", [url(42)], {})).toEqual({ ok: false, error: "Resume or reopen this effort first.", skipped: [] });
    expect(refused.calls).toEqual(["plan address 1"]);
    const failed = fake(new Error("RPC timed out"));
    expect(await startAddress(failed.rpc, null, [url(42)], {})).toEqual({ ok: false, error: "RPC timed out", skipped: [] });
    const busy = { prUrl: url(42), ref: "folio #42", reason: "An agent is already working on it." };
    const none = fake({ ok: true, batchId: null, items: [], skipped: [busy, held] });
    expect(await startAddress(none.rpc, null, [42, 45].map(url), {})).toEqual({ ok: false, error: "Nothing started. folio #42: An agent is already working on it.",
      skipped: [busy, held] });
    expect(none.calls).toEqual(["plan address 2"]);
    const late = fake({ ok: true, batchId: "b-3", items: [{}], skipped: [held] }, { ok: false, error: "folio #42: Its effort is on hold. Review the batch again." });
    expect(await startAddress(late.rpc, null, [42, 45].map(url), {})).toEqual({ ok: false,
      error: "Nothing started. folio #42: Its effort is on hold. Review the batch again.", skipped: [held] });
  });
});

// Matt: "it takes a while to advance any checked PRs and there's zero UI feedback." A batch button works from its click until its plan
// answers, a second click or key while one is out plans nothing, and the rows it takes show pending until it answers or fails.
describe("a batch button while its plan is out", () => {
  /** A plan that answers when told, and the states the button and rows went through. */
  function deferred() {
    const shown: (Working | null)[] = [];
    let settle!: { resolve(): void; reject(error: Error): void };
    const calls: string[] = [];
    const plan = (kind: string) => () => { calls.push(kind); return new Promise<void>((resolve, reject) => { settle = { resolve, reject }; }); };
    return { shown, calls, plan, settle: () => settle, run: oneAtATime((working) => shown.push(working)) };
  }

  it("shows the pressed button working and its rows pending until the plan answers, and ignores a repeat press meanwhile", async () => {
    const flow = deferred();
    const rows = new Set([url(42), url(43)]);
    const first = flow.run({ kind: "advance", prUrls: rows }, flow.plan("advance"));
    expect(flow.shown).toEqual([{ kind: "advance", prUrls: rows }]);
    expect(workingLabel(flow.shown[0]!)).toBe("Planning…");
    // The key pressed again, and another button, while the plan is out: neither plans.
    expect(await flow.run({ kind: "advance", prUrls: rows }, flow.plan("advance"))).toBe(false);
    expect(await flow.run({ kind: "nudge", prUrls: rows }, flow.plan("nudge"))).toBe(false);
    expect(flow.calls).toEqual(["advance"]);
    flow.settle().resolve();
    expect(await first).toBe(true);
    // Answered: nothing works or pends, and the next press plans.
    expect(flow.shown.at(-1)).toBeNull();
    void flow.run({ kind: "nudge", prUrls: rows }, flow.plan("nudge"));
    expect(flow.calls).toEqual(["advance", "nudge"]);
  });

  it("clears the working button and pending rows when the call fails, and says Starting… for Address", async () => {
    const flow = deferred();
    const out = flow.run({ kind: "address", prUrls: new Set([url(42)]) }, flow.plan("address"));
    expect(workingLabel(flow.shown[0]!)).toBe("Starting…");
    flow.settle().reject(new Error("RPC timed out"));
    await expect(out).rejects.toThrow("RPC timed out");
    expect(flow.shown).toEqual([{ kind: "address", prUrls: new Set([url(42)]) }, null]);
    expect(await flow.run({ kind: "address", prUrls: new Set([url(42)]) }, async () => undefined)).toBe(true);
  });
});

// Once the Undo window closes, dispatch sends one item at a time; the status line counts them as each settles.
describe("a batch while it sends", () => {
  const items = (...states: ("pending" | "sending" | "sent" | "refused" | "unknown")[]) => states.map((state) => ({ state }));
  it("says which item of how many is sending, from the items' states, and nothing once it isn't sending", () => {
    expect(sendingText({ state: "dispatching", kind: "advance", items: items("sending", "pending", "pending") })).toBe("Sending 1 of 3…");
    expect(sendingText({ state: "dispatching", kind: "advance", items: items("sent", "refused", "sending", "pending", "pending", "pending", "pending") }))
      .toBe("Sending 3 of 7…");
    expect(sendingText({ state: "dispatching", kind: "nudge", items: items("sent", "sent", "sent") })).toBe("Sending 3 of 3…");
    expect(sendingText({ state: "dispatching", kind: "address", items: items("sending", "sending") })).toBe("Starting a thread for 2 PRs…");
    expect(sendingText({ state: "scheduled", kind: "advance", items: items("pending") })).toBeNull();
    expect(sendingText({ state: "done", kind: "advance", items: items("sent") })).toBeNull();
  });
});
