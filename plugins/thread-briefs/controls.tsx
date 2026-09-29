/**
 * The two pin controls and the labelled field, shared by the Brief panel and the
 * board's expanded card.
 *
 * Extracted out of `app.tsx` when the board arrived, and given props rather than
 * a whole {@link ResolvedBrief}: the board holds a card, not a resolved brief,
 * and these only ever read four values. It is also the board's answer to touch
 * — drag-and-drop is a pointer affordance, so the expanded card has to offer the
 * same two writes as a tappable control, and the honest way to do that is the
 * control the panel already uses rather than a second one that looks different.
 */
import {
  experimental_Icon as Icon,
} from "@get-bb/plugin-sdk/app";
import type { BriefStage, BriefStatus, StoredBriefStatus } from "./contract.js";
import { BRIEF_STAGES, STORED_BRIEF_STATUSES } from "./shared.js";
import { STAGE_LABELS, STATUS_LABELS, stageRingIcon } from "./brief.js";

export function Field({ label, value }: { label: string; value: string }) {
  if (value.trim() === "") return null;
  return (
    <div className="space-y-0.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm leading-snug text-foreground">{value}</div>
    </div>
  );
}

/** The note under a control saying a pin is in force and how it ends. */
function PinNote() {
  return (
    <div className="text-[11px] text-muted-foreground">
      Set by hand · clears on the next turn
    </div>
  );
}

export function StageControl({
  stage,
  stageOverride,
  onPick,
}: {
  /** The effective stage — the pin if one holds, else the model's judgement. */
  stage: BriefStage;
  /** The pin, only while it is still in force. */
  stageOverride: BriefStage | null;
  onPick: (stage: BriefStage | null) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Stage
      </div>
      <div className="flex flex-wrap gap-1">
        {BRIEF_STAGES.map((option) => {
          const isActive = stage === option;
          const isManual = stageOverride === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={isActive}
              // Picking the stage that is already manually set clears the
              // override and hands the judgement back to the summarizer.
              onClick={() => onPick(isManual ? null : option)}
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${
                isActive
                  ? "border-border bg-card font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-card"
              }`}
            >
              {/*
                Each option next to its own ring, which is where the sidebar's
                glyph is learned: four labelled rings in a row say what a single
                ring on a row cannot.
              */}
              <Icon
                name={stageRingIcon(option)}
                className="h-3 w-3 shrink-0"
                aria-hidden
              />
              {STAGE_LABELS[option]}
              {isManual ? " ·" : ""}
            </button>
          );
        })}
      </div>
      {stageOverride !== null ? <PinNote /> : null}
    </div>
  );
}

/**
 * The manual status, in the same shape as the stage control beside it.
 *
 * Status is otherwise derived from the brief's own prose, which has no way to
 * learn that a `nextStep` addressed to you was carried out somewhere the
 * transcript cannot see — reload a client, confirm a rollout, check a glyph.
 * Doing it leaves no trace to summarize, so without this the thread is
 * "Waiting on you" for good. Dragging its sidebar row elsewhere does not help:
 * sections are keyed on this status, so the next reconcile files it straight
 * back.
 *
 * No rings beside the options, unlike the stage control. The row glyph draws
 * the *stage*, and only `done` gets a status treatment at all (tone, and the
 * closed ring in place of the stage), so three labelled rings here would be two
 * identical glyphs and a claim that status is what the row shows.
 *
 * `status` is the full union rather than the three a pin may take, because the
 * live `working` is a thing this control has to be able to *display* as active
 * without offering it: pinning a thread to "working" would be pinning it to a
 * fact about right now.
 */
export function StatusControl({
  status,
  statusOverride,
  onPick,
}: {
  status: BriefStatus;
  statusOverride: StoredBriefStatus | null;
  onPick: (status: StoredBriefStatus | null) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Status
      </div>
      <div className="flex flex-wrap gap-1">
        {STORED_BRIEF_STATUSES.map((option) => {
          const isActive = status === option;
          const isManual = statusOverride === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={isActive}
              // Picking the status that is already pinned clears the override
              // and hands the judgement back to the derivation.
              onClick={() => onPick(isManual ? null : option)}
              className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs ${
                isActive
                  ? "border-border bg-card font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-card"
              }`}
            >
              {STATUS_LABELS[option]}
              {isManual ? " ·" : ""}
            </button>
          );
        })}
      </div>
      {statusOverride !== null ? <PinNote /> : null}
    </div>
  );
}
