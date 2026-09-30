// Address selected with no listing: one click plans one batch thread and starts it into the Undo window, and every way it can start
// nothing comes back in the server's words for the selection bar and the rows. Every name here is synthetic.
import { describe, expect, it } from "vitest";
import { addressToast, startAddress } from "./deck-flow.js";

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
