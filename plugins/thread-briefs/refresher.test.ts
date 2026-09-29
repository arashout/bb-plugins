import { describe, expect, it } from "vitest";
import {
  chooseRefresher,
  refresherSeenKey,
  REFRESHER_COLD_MULTIPLE,
  type RefresherDecision,
} from "./refresher.js";

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;
const THRESHOLD = 1 * HOUR;

/** Idle for two days, never dismissed, nothing pinned: the case that shows. */
const decision = (overrides: Partial<RefresherDecision> = {}): RefresherDecision => ({
  prose: {
    short: "You were wiring the sidebar sections to brief status. Next: run the reconcile.",
    full: "You were wiring the sidebar sections to brief status, and the sync now lands. The section order is still not pinned, so the three sections come back in creation order. Next: run the reconcile and check manualSectionOrder.",
    writtenForStatus: "waiting-on-me",
  },
  status: "waiting-on-me",
  threadStatus: "idle",
  latestAttentionAt: NOW - 2 * 24 * HOUR,
  dismissedAt: null,
  now: NOW,
  thresholdMs: THRESHOLD,
  ...overrides,
});

describe("refresherSeenKey", () => {
  it("does not collide with the brief keys the kv scans walk", () => {
    // `listRowSignals` and the section sync both scan the `brief:` prefix; a
    // dismissal picked up by either would fail the brief parse and be deleted.
    expect(refresherSeenKey("thr_1").startsWith("brief:")).toBe(false);
    expect(refresherSeenKey("thr_1")).toContain("thr_1");
  });
});

describe("chooseRefresher", () => {
  it("shows the reorientation on a thread left days ago", () => {
    const choice = chooseRefresher(decision());
    expect(choice?.variant).toBe("full");
    expect(choice?.text).toContain("sidebar sections");
    // The cursor travels with the choice so the dismissal can name it.
    expect(choice?.attentionAt).toBe(NOW - 2 * 24 * HOUR);
  });

  it("is off entirely at a threshold of zero", () => {
    // The setting's own off switch, rather than a second boolean that could
    // come to disagree with it.
    expect(chooseRefresher(decision({ thresholdMs: 0 }))).toBeNull();
    expect(chooseRefresher(decision({ thresholdMs: -1 }))).toBeNull();
  });

  describe("the two trigger conditions", () => {
    it("says nothing on a thread you were in ten minutes ago", () => {
      expect(
        chooseRefresher(decision({ latestAttentionAt: NOW - 10 * 60_000 })),
      ).toBeNull();
    });

    it("fires the moment the threshold is reached, not a tick before", () => {
      expect(
        chooseRefresher(decision({ latestAttentionAt: NOW - THRESHOLD })),
      ).not.toBeNull();
      expect(
        chooseRefresher(decision({ latestAttentionAt: NOW - THRESHOLD + 1 })),
      ).toBeNull();
    });

    it("says nothing once this activity has been dismissed", () => {
      const at = NOW - 2 * 24 * HOUR;
      expect(
        chooseRefresher(decision({ latestAttentionAt: at, dismissedAt: at })),
      ).toBeNull();
    });

    it("comes back when the thread does something new you have not seen", () => {
      // The dismissal covers the cursor it was shown for and nothing later, so
      // a turn that landed after it re-earns the card.
      const choice = chooseRefresher(
        decision({
          latestAttentionAt: NOW - 2 * 24 * HOUR,
          dismissedAt: NOW - 3 * 24 * HOUR,
        }),
      );
      expect(choice).not.toBeNull();
    });
  });

  describe("which variant", () => {
    it("keeps it short just past the threshold", () => {
      const choice = chooseRefresher(
        decision({ latestAttentionAt: NOW - THRESHOLD }),
      );
      expect(choice?.variant).toBe("short");
    });

    it("switches to the fuller one once the thread has gone cold", () => {
      const cold = THRESHOLD * REFRESHER_COLD_MULTIPLE;
      expect(
        chooseRefresher(decision({ latestAttentionAt: NOW - cold + 1 }))?.variant,
      ).toBe("short");
      expect(
        chooseRefresher(decision({ latestAttentionAt: NOW - cold }))?.variant,
      ).toBe("full");
    });

    it("falls back to the variant the model actually wrote", () => {
      // One sentence in the wrong register beats no reorientation at all.
      const onlyShort = chooseRefresher(
        decision({
          prose: {
            short: "You were mid-reconcile.",
            full: "",
            writtenForStatus: "waiting-on-me",
          },
        }),
      );
      expect(onlyShort).toEqual({
        text: "You were mid-reconcile.",
        variant: "short",
        attentionAt: NOW - 2 * 24 * HOUR,
      });
    });

    it("says nothing when neither variant has words in it", () => {
      expect(
        chooseRefresher(
          decision({
            prose: { short: "  ", full: "", writtenForStatus: "waiting-on-me" },
          }),
        ),
      ).toBeNull();
    });
  });

  describe("what it refuses to show", () => {
    it("says nothing on a thread with no brief, or a brief from before this existed", () => {
      expect(chooseRefresher(decision({ prose: null }))).toBeNull();
      expect(chooseRefresher(decision({ prose: undefined }))).toBeNull();
    });

    it("says nothing while the agent is running or queued", () => {
      // Live state outranks anything stored: the sentence would be describing a
      // position that is already moving.
      for (const status of ["active", "starting", "pending"]) {
        expect(chooseRefresher(decision({ threadStatus: status }))).toBeNull();
      }
      expect(chooseRefresher(decision({ threadStatus: "idle" }))).not.toBeNull();
    });

    it("says nothing once you have pinned a status the prose was not written for", () => {
      // The requirement this exists for: prose that says "carry on" must not
      // survive you calling the thread blocked. Showing nothing is the honest
      // answer, because rewriting it here would be a model call on open.
      expect(
        chooseRefresher(decision({ status: "waiting-on-other" })),
      ).toBeNull();
      expect(chooseRefresher(decision({ status: "done" }))).toBeNull();
    });

    it("shows prose written for the pin once the re-summary has landed", () => {
      const choice = chooseRefresher(
        decision({
          status: "waiting-on-other",
          prose: {
            short: "You parked this waiting on the upstream fix in get-bb/bb#4338.",
            full: "You parked this waiting on the upstream fix in get-bb/bb#4338. Nothing to do here until it merges.",
            writtenForStatus: "waiting-on-other",
          },
        }),
      );
      expect(choice?.text).toContain("4338");
    });
  });
});
