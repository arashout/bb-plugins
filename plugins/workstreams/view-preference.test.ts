import { afterEach, describe, expect, it, vi } from "vitest";
import { deckLinkStep, deckRoute, readLastView, rosterRoute, storeLastView, viewFromSubPath, VIEW_STORAGE_KEY } from "./view-preference.js";

afterEach(() => vi.unstubAllGlobals());

describe("Workstreams view preference", () => {
  it("keeps explicit view links independent of the remembered view", () => {
    expect(viewFromSubPath("deck")).toBe("deck");
    expect(viewFromSubPath("inventory")).toBe("inventory");
    expect(viewFromSubPath("map")).toBe("map");
    expect(viewFromSubPath("pipeline/details")).toBe("pipeline");
    expect(viewFromSubPath("work/details")).toBe("work");
    expect(viewFromSubPath("efforts/details")).toBe("efforts");
    expect(viewFromSubPath("board/details")).toBe("board");
    expect(viewFromSubPath("board-v2/details")).toBe("board");
    expect(viewFromSubPath("")).toBeNull();
    expect(viewFromSubPath("unknown")).toBeNull();
  });

  it("opens the deck on the card a thread's effort chip links to", () => {
    expect(viewFromSubPath("deck/effort-shelf-order")).toBe("deck");
    expect([deckRoute("deck/effort-shelf-order"), deckRoute(`deck/${encodeURIComponent("effort:a b")}`)]).toEqual(["effort-shelf-order", "effort:a b"]);
    expect([deckRoute("deck"), deckRoute("roster/effort-shelf-order")]).toEqual([null, null]);
  });

  // The chip links with toPluginPanel("board", { subPath: `deck/${encodeURIComponent(card)}` }). BB encodes each "/"-separated part of
  // a sub-path again for the URL, and its router decodes each part once and then turns "%2F" back into "/" for the panel's sub-path. A
  // service card's id has a "/" in it, so it reaches the panel split across two parts.
  it("opens a service card from the chip's link as BB routes it", () => {
    const routed = (subPath: string) => subPath.split("/").filter(Boolean).map(encodeURIComponent)
      .map((part) => decodeURIComponent(part).replace(/\//gu, "%2F")).join("/").replace(/%2F/gu, "/");
    const link = (card: string) => deckRoute(routed(`deck/${encodeURIComponent(card)}`));
    expect(routed(`deck/${encodeURIComponent("service:inkwell/folio")}`)).toBe("deck/service%3Ainkwell/folio");
    expect([link("service:inkwell/folio"), link("effort-shelf-order"), link("effort:a b"), link("loose")])
      .toEqual(["service:inkwell/folio", "effort-shelf-order", "effort:a b", "loose"]);
  });

  it("waits for a deck read after the link before giving up on a card, since a cached deck can predate one just made", () => {
    const deck = { ring: ["effort-shelf-order", "service:inkwell/folio"], held: ["effort-gift-cards"] };
    expect([deckLinkStep("effort-shelf-order", deck, false), deckLinkStep("service:inkwell/folio", deck, false), deckLinkStep("effort-gift-cards", deck, false)])
      .toEqual(["open", "open", "hold"]);
    expect([deckLinkStep("effort-store-pickup", deck, false), deckLinkStep("effort-store-pickup", deck, true)]).toEqual(["read", "drop"]);
  });

  it("opens the effort deck first, even over a view remembered before it existed, then remembers the last explicit view", () => {
    // The deck is the front door (plan amendment A15): the inventory, Map, or Pipeline remembered under an older key doesn't hide it.
    const values = new Map<string, string>([["bb-workstreams:last-view", "pipeline"], ["bb-workstreams:last-view-since-inventory", "inventory"]]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });

    expect(readLastView()).toBe("deck");
    storeLastView("map");
    expect(readLastView()).toBe("map");
    storeLastView("inventory");
    expect(readLastView()).toBe("inventory");
    storeLastView("deck");
    expect(readLastView()).toBe("deck");
    storeLastView("board");
    expect(values.get(VIEW_STORAGE_KEY)).toBe("board");
    expect(readLastView()).toBe("board");
    storeLastView("pipeline");
    expect(readLastView()).toBe("pipeline");
    storeLastView("work");
    expect(readLastView()).toBe("work");
    storeLastView("efforts");
    expect(readLastView()).toBe("efforts");
    values.set(VIEW_STORAGE_KEY, "board-v2");
    expect(readLastView()).toBe("board");
    storeLastView("map");
    expect(readLastView()).toBe("map");
    values.set(VIEW_STORAGE_KEY, "unexpected");
    expect(readLastView()).toBe("deck");
  });

  it("routes to an effort's roster and focused row, and never reopens a roster from the panel root", () => {
    expect(rosterRoute("roster")).toEqual({ effortId: null, n: null });
    expect(rosterRoute("roster/eff-shelving")).toEqual({ effortId: "eff-shelving", n: null });
    expect(rosterRoute("roster/eff-shelving/7")).toEqual({ effortId: "eff-shelving", n: 7 });
    expect(rosterRoute(`roster/${encodeURIComponent("effort:a/b")}/x`)).toEqual({ effortId: "effort:a/b", n: null });
    expect(rosterRoute("efforts/eff-shelving")).toBeNull();
    expect(viewFromSubPath("roster/eff-shelving/7")).toBe("roster");

    const values = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
    storeLastView("pipeline");
    storeLastView("roster");
    expect(readLastView()).toBe("pipeline");
    values.set(VIEW_STORAGE_KEY, "roster");
    expect(readLastView()).toBe("deck");
  });

  it("keeps every view usable when browser storage is unavailable", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("Storage disabled");
      },
    });
    expect(readLastView()).toBe("deck");
    expect(() => storeLastView("board")).not.toThrow();
  });
});
