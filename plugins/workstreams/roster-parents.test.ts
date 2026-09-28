import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RosterHeaderControl } from "./roster-header";
import { rosterPanelOpen, rosterParents, setRosterParents, subscribeRosterParents, type RosterListEntry } from "./roster-parents";

const shelving: RosterListEntry = { id: "eff-shelving", key: "shelving-entry", name: "Shelving entry", archived: false, mode: "v2", parentThreadId: "thr_shelving_parent" };
const catalog: RosterListEntry = { id: "eff-catalog", key: "catalog", name: "Catalog follow-ups", archived: false, mode: "legacy", parentThreadId: null };

describe("effort parent threads", () => {
  it("opens a parent thread's own roster, and the picker from any other thread", () => {
    setRosterParents([shelving, catalog]);
    expect(rosterPanelOpen("thr_shelving_parent", rosterParents())).toEqual({ title: "Shelving entry roster", params: { effortId: "eff-shelving" } });
    expect(rosterPanelOpen("thr_worker", rosterParents())).toBeUndefined();
    // Only a v2 effort reports to its parent thread, even if a legacy list entry named one.
    setRosterParents([shelving, { ...catalog, parentThreadId: "thr_catalog_coordinator" }]);
    expect(rosterPanelOpen("thr_catalog_coordinator", rosterParents())).toBeUndefined();
  });

  it("tells mounted headers only when a parent or its name changes, so a roster signal doesn't redraw every thread header", () => {
    setRosterParents([shelving, catalog]);
    let heard = 0;
    const stop = subscribeRosterParents(() => heard++);
    setRosterParents([catalog, shelving]);
    setRosterParents([shelving, { ...catalog, name: "Catalog renamed" }]);
    expect(heard).toBe(0);
    setRosterParents([{ ...shelving, name: "Shelving intake" }, catalog]);
    expect(heard).toBe(1);
    setRosterParents([{ ...shelving, name: "Shelving intake", mode: "legacy", parentThreadId: null }]);
    expect(heard).toBe(2);
    expect(rosterParents().size).toBe(0);
    stop();
  });

  it("draws the header button only in an effort parent thread, and an icon alone when compact", () => {
    const control = (parent: { effortId: string; name: string } | null, compact: boolean) =>
      renderToStaticMarkup(createElement(RosterHeaderControl, { parent, compact, onOpen: () => {} }));
    expect(control(null, false)).toBe("");
    expect(control({ effortId: "eff-shelving", name: "Shelving entry" }, false)).toMatch(/aria-label="Open the Shelving entry roster"[^>]*>.*Roster<\/button>$/u);
    expect(control({ effortId: "eff-shelving", name: "Shelving entry" }, true)).not.toContain("Roster</button>");
  });
});
