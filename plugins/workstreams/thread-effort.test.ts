import { describe, expect, it } from "vitest";
import { serviceName, threadEffortChip, threadEffortSignals } from "./thread-effort.js";

const SHELF = { id: "shelf", name: "Shelf order" }, PICKUP = { id: "pickup", name: "Store pickup" }, GIFTS = { id: "gifts", name: "Gift cards" };
const none = { linked: [], titleTickets: [], parentEffortId: null, classified: [] };

describe("a thread's effort signals", () => {
  it("puts the effort holding the thread's own PRs first, then a ticket in the title, then the classifier and the parent's effort", () => {
    const ranked = threadEffortSignals({ efforts: [SHELF, PICKUP, GIFTS],
      linked: [{ ref: "folio #340", effortId: "shelf" }, { ref: "folio #341", effortId: "shelf" }, { ref: "folio #99", effortId: null }],
      titleTickets: [{ ticket: "ABC-121", effortId: "pickup" }],
      parentEffortId: "gifts",
      classified: [{ effortId: "gifts", confidence: "low", signal: "Linear project “Gift cards”" }] });
    // Gift cards' two weaker kinds (parent 2 + low 1) weigh as much as one strong kind, so the strongest one signal breaks the tie.
    expect(ranked).toEqual([
      { id: "shelf", score: 3, signal: "has 2 linked PRs" },
      { id: "pickup", score: 3, signal: "ABC-121 in the title" },
      { id: "gifts", score: 3, signal: "parent thread's effort" },
    ]);
  });

  it("adds up different kinds for one effort and names the strongest, so two signals outrank one", () => {
    const ranked = threadEffortSignals({ ...none, efforts: [SHELF, PICKUP],
      linked: [{ ref: "folio #340", effortId: "shelf" }], titleTickets: [{ ticket: "ABC-360", effortId: "shelf" }],
      classified: [{ effortId: "pickup", confidence: "high", signal: "ticket ABC-121" }] });
    expect(ranked).toEqual([{ id: "shelf", score: 6, signal: "has folio #340" }, { id: "pickup", score: 3, signal: "ticket ABC-121" }]);
  });

  it("counts each kind once, keeping its strongest", () => {
    expect(threadEffortSignals({ ...none, efforts: [SHELF], classified: [{ effortId: "shelf", confidence: "low", signal: "area folio/app" },
      { effortId: "shelf", confidence: "medium", signal: "ticket ABC-360" }] })).toEqual([{ id: "shelf", score: 2, signal: "ticket ABC-360" }]);
  });

  it("suggests nothing it can't offer: an effort that's done, archived, or unknown, or a ticket no effort has", () => {
    expect(threadEffortSignals({ ...none, efforts: [PICKUP], linked: [{ ref: "folio #340", effortId: "shelf" }],
      titleTickets: [{ ticket: "ABC-999", effortId: null }], parentEffortId: "gone" })).toEqual([]);
  });
});

describe("a thread's effort chip", () => {
  const shelf = { id: "shelf", name: "Shelf order", oneOff: false }, pickup = { id: "pickup", name: "Store pickup", oneOff: false };
  const counts = (effortId: string) => effortId === "done" ? null : 4;

  it("names the thread's own effort over the one it coordinates and the one its PRs are in", () => {
    expect(threadEffortChip({ own: pickup, coordinates: shelf, linked: [{ repo: "inkwell/folio", effort: shelf }], needsYou: counts }))
      .toEqual({ kind: "effort", effortId: "pickup", name: "Store pickup", oneOff: false, needsYou: 4, card: "pickup" });
    expect(threadEffortChip({ own: null, coordinates: shelf, linked: [{ repo: "inkwell/folio", effort: pickup }], needsYou: counts }).effortId).toBe("shelf");
  });

  it("falls back to the effort most of its linked PRs are in", () => {
    expect(threadEffortChip({ own: null, coordinates: null, needsYou: counts,
      linked: [{ repo: "inkwell/folio", effort: pickup }, { repo: "inkwell/folio", effort: shelf }, { repo: "inkwell/atlas", effort: shelf }] }).name).toBe("Shelf order");
  });

  it("falls back to the service card of its PRs' repository when no effort has them, whose PRs count as Needs you as an effort's do", () => {
    expect(threadEffortChip({ own: null, coordinates: null, needsYou: counts,
      linked: [{ repo: "inkwell/Atlas", effort: null }, { repo: "inkwell/folio", effort: null }, { repo: "inkwell/atlas", effort: null }] }))
      .toEqual({ kind: "service", effortId: null, name: "atlas · service", oneOff: false, needsYou: 4, card: "service:inkwell/atlas" });
    // A tie goes by name, so the chip doesn't change between reads.
    expect(threadEffortChip({ own: null, coordinates: null, needsYou: counts,
      linked: [{ repo: "inkwell/folio", effort: null }, { repo: "inkwell/atlas", effort: null }] }).name).toBe(serviceName("inkwell/atlas"));
  });

  it("says No effort for a thread with no effort and no linked PR, and opens no card for an effort the deck doesn't draw", () => {
    expect(threadEffortChip({ own: null, coordinates: null, linked: [], needsYou: counts }))
      .toEqual({ kind: "none", effortId: null, name: "No effort", oneOff: false, needsYou: 0, card: null });
    expect(threadEffortChip({ own: { id: "done", name: "Store hours", oneOff: false }, coordinates: null, linked: [], needsYou: counts }))
      .toMatchObject({ kind: "effort", name: "Store hours", needsYou: 0, card: null });
  });
});
