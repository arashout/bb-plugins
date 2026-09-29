// The effort deck in the Workstreams panel (plan amendment A15): deck_get
// live from the server, the one key registry, and every write through a
// listing confirm that waits out its Undo window, or through the fresh merge
// preview. Membership changes (accept, move, one-off, new effort, rules) and
// pile moves are each one explicit click or key with Undo.
//
// This is the part that talks to BB and the DOM: it keeps your place per view
// in the session (deck-place.ts), holds rows at their pixel through reads,
// resizes, flips, and Mark seen, and never leaves focus on the page body.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { DeckView } from "./deck";
import { DECK_CHANGED } from "./deck-shared";
import type { DeckActionId } from "./deck-keys";
import { anchorScroll, EMPTY_VIEW, focusFallback, keepOrder, meltSlack, PLACE_KEY, readPlace, readSeen, SEEN_KEY, type Anchor, type FocusKey, type Place,
  type Seen, type ViewPlace } from "./deck-place";
import { acceptLabel, acceptPlan, availability, cardScreen, cardSnapshot, hintKeys, KIND_OF, paletteItems, paletteMatch, readText, SECTIONS, stripChips, targets, threadSnapshot, threadsKey,
  uncScreen, uncSnapshot, type Accepted, type DeckLine, type KeyContext, type PaletteItem, type UncGroup } from "./deck-view-model";
import { CompleteBody, DeckPane, HelpBody, HoldBody, MoveBody, NewEffortBody, PaletteBody, RULE_WORDS, RuleBody, SeedBody, WeakBody, type DeckCommand,
  type RuleDraft, type RuleItem } from "./deck-screen";
import { DeckDialog, message, useBatchConfirm, useRegistryKeys, type Undo } from "./deck-flow";
import { EASE, FLIP_MS, flipMotion, flipper, focusNamesCard, ghostOf, playFlip, settleFlip, type FlipMotion } from "./deck-flip";
import { MergePreviewDialog } from "./roster-merge-dialog";
import type { SeedProposal } from "./linear-seed";

type OtherView = "prs" | "map" | "pipeline" | "work" | "efforts";
const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
/** The last deck read, so coming back to the deck draws it at once instead of "Reading…" (PLACE-LOSS #1). */
let cachedDeck: DeckView | null = null;

function readStore<T>(storage: "sessionStorage" | "localStorage", key: string, parse: (raw: string | null) => T): T {
  try { return parse(window[storage].getItem(key)); } catch { return parse(null); }
}
function writeStore(storage: "sessionStorage" | "localStorage", key: string, value: unknown) {
  try { window[storage].setItem(key, JSON.stringify(value)); } catch { /* The deck still works for this visit without storage. */ }
}
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), ms); return () => window.clearInterval(timer); }, [ms]);
  return now;
}

/** deck_get, read on mount, on deck-changed, and when the page shows again; a signal during a read reads once more after it. */
function useDeck(seenAt: () => Record<string, number>, beforeUpdate: () => void) {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<DeckView | null>(cachedDeck);
  const [error, setError] = useState<string | null>(null);
  const reading = useRef(false);
  const again = useRef(false);
  const before = useRef(beforeUpdate);
  before.current = beforeUpdate;
  const seen = useRef(seenAt);
  seen.current = seenAt;
  const load = useCallback(function read(): void {
    if (reading.current) { again.current = true; return; }
    reading.current = true;
    rpc.call("deck_get", { seen: seen.current() }).then((next) => { before.current(); cachedDeck = next; setView(next); setError(null); },
      (cause: unknown) => setError(message(cause))).finally(() => {
      reading.current = false;
      if (again.current) { again.current = false; read(); }
    });
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime(DECK_CHANGED, () => load());
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);
  return { rpc, view, error, load };
}

type Dialogs =
  | { kind: "hold"; id: string; effortKey: string; name: string; reason: string } | { kind: "complete"; id: string }
  | { kind: "hold-pr"; prUrl: string; ref: string; reason: string }
  | { kind: "rule"; draft: RuleDraft; matches: number | null } | { kind: "new"; prUrls: string[]; refs: string[]; name: string; goal: string; group: string | null }
  | { kind: "move"; prUrls: string[]; refs: string[]; group: string | null } | { kind: "palette"; query: string; highlight: number } | { kind: "help" }
  | { kind: "seed"; proposals: SeedProposal[] | null; keyed: boolean; picked: string[]; requestId: string }
  | { kind: "weak"; group: string; lines: readonly DeckLine[] };

export function DeckNavView({ onView }: { onView(view: OtherView): void }) {
  const navigate = useBbNavigate();
  const placeRef = useRef<Place>(readStore("sessionStorage", PLACE_KEY, readPlace));
  const [seen, setSeen] = useState<Seen>(() => readStore("localStorage", SEEN_KEY, (raw) => readSeen(raw, Date.now())));
  const seenRef = useRef(seen);
  seenRef.current = seen;
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((value) => value + 1), []);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const slackRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const slack = useRef(0);
  const pendingAnchor = useRef<Anchor | null>(null);
  const liveAnchor = useRef<Anchor | null>(null);
  const lastFocus = useRef<FocusKey | null>(null);
  const pendingFocus = useRef<FocusKey | null>(null);
  /** The pending focus follows an action, so it scrolls into view if it has to. */
  const scrollFocus = useRef(false);
  const lastFocusElement = useRef<Element | null>(null);
  const opener = useRef<FocusKey>({});
  /** The flip the next render lands, with the card it takes away, and the flips so far, which know when the last one started. */
  const landing = useRef<{ direction: 1 | -1; motion: FlipMotion; ghost: HTMLElement | null } | null>(null);
  const [flips] = useState(flipper);
  /** The card a flip landed on, for screen readers, once the flips stop. */
  const [announce, setAnnounce] = useState("");
  const announceTimer = useRef<number | null>(null);
  const [stuck, setStuck] = useState(false);
  const [activeRow, setActiveRow] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Accepted>(new Map());
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [merging, setMerging] = useState<{ target: string; n: null }[] | null>(null);
  const [pile, setPile] = useState<"hold" | "done" | null>(null);
  const [flash, setFlash] = useState<{ text: string; undo: boolean } | null>(null);
  const [seenNote, setSeenNote] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [rules, setRules] = useState<RuleItem[]>([]);
  const now = useNow(30_000);

  const scrollBox = () => scrollerRef.current?.getBoundingClientRect() ?? null;
  const inView = (element: Element) => {
    const box = scrollBox();
    const rect = element.getBoundingClientRect();
    return !!box && rect.top >= box.top + (stuck ? 34 : 0) + 30 && rect.bottom <= box.bottom + 1;
  };
  /** What holds your place now: `prefer`, else the focused row in view, else the card's top while it shows, else the first row below the top. */
  const captureAnchor = useCallback((prefer?: Element | null): Anchor | null => {
    const box = scrollBox();
    const view = viewRef.current;
    if (!box || !view) return null;
    const focused = document.activeElement?.closest?.("[data-deck-row]");
    const row = [prefer, focused].find((element) => element && view.contains(element) && inView(element));
    if (row) return { row: (row as HTMLElement).dataset.deckRow!, at: row.getBoundingClientRect().top - box.top };
    // The stack's box: the card on top, without the edges of the cards behind it.
    const card = view.querySelector("[data-deck-stack]");
    const cardBox = card?.getBoundingClientRect();
    if (cardBox && cardBox.bottom > box.top + 40) return { card: true, at: cardBox.top - box.top };
    for (const element of Array.from(view.querySelectorAll<HTMLElement>("[data-deck-row]"))) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom > box.top + (stuck ? 34 : 0) + 36) return { row: element.dataset.deckRow!, at: rect.top - box.top };
    }
    return null;
  }, [stuck]);
  const setSlack = (value: number) => { slack.current = value; if (slackRef.current) slackRef.current.style.height = `${value}px`; };
  const restoreAnchor = useCallback((anchor: Anchor | null) => {
    const scroller = scrollerRef.current;
    const view = viewRef.current;
    if (!anchor || !scroller || !view) return;
    const element = "card" in anchor ? view.querySelector("[data-deck-stack]") : view.querySelector(`[data-deck-row="${CSS.escape(anchor.row)}"]`);
    if (!element) return;
    const next = anchorScroll({ scrollTop: scroller.scrollTop, slack: slack.current, at: element.getBoundingClientRect().top - scroller.getBoundingClientRect().top, want: anchor.at });
    setSlack(next.slack);
    scroller.scrollTop = next.scrollTop;
  }, []);

  const { rpc, view, error, load } = useDeck(() => seenRef.current.at, () => { pendingAnchor.current = captureAnchor(); });
  const flashTimer = useRef<number | null>(null);
  const say = useCallback((text: string, withUndo = false, ms?: number) => {
    setFlash({ text, undo: withUndo });
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), ms ?? (withUndo ? 9_000 : 5_000));
  }, []);
  const batch = useBatchConfirm({ seenAt: () => seenRef.current.at, scopeName: (id) => view?.active.find((item) => item.id === id)?.name ?? null, say, setUndo, load,
    onOpen: () => { const key = focusKey(document.activeElement); if (key.id || key.row) opener.current = key; }, onReturn: () => returnFocus(), reread: view });
  const details = batch.details;

  // ---- what the deck shows -------------------------------------------------
  const place = placeRef.current;
  const cards = useMemo(() => new Map((view?.active ?? []).map((item) => [item.id, cardScreen(item, seen, { now, details })])), [view, seen, now, details]);
  const order = useMemo(() => keepOrder(place.order, view?.active.map((item) => item.id) ?? []), [view, place.order]);
  const ring = useMemo(() => [...order, "unc"], [order]);
  const cur = place.cur && ring.includes(place.cur) ? place.cur : ring[0]!;
  const card = cur === "unc" ? null : cards.get(cur) ?? null;
  const unc = useMemo(() => view && uncScreen(view, seen, accepted, { now }), [view, seen, accepted, now]);
  const viewPlace = (key: string): ViewPlace => (place.views[key] ??= { ...EMPTY_VIEW, selected: [], expanded: [], tiles: [], open: [] });
  const here = viewPlace(cur);
  // Focus and scroll events can fire between a flip's render and its effects; they read the card shown now.
  const curRef = useRef(cur);
  curRef.current = cur;
  const lines: DeckLine[] = card ? card.sections.flatMap((section) => section.lines) : unc?.groups.flatMap((group) => group.lines) ?? [];
  const focused = lines.find((line) => line.prUrl === activeRow) ?? null;
  const selected = lines.filter((line) => here.selected.includes(line.prUrl) && !line.dim);
  const changedHere = card ? card.changed : unc?.changed ?? 0;
  const settleable = card ? card.settleable : accepted.size > 0;
  const chips = useMemo(() => stripChips(order, cards, { toSort: unc?.coverage.toSort ?? 0, changed: unc?.changed ?? 0 }, cur), [order, cards, unc, cur]);
  const context: KeyContext = { view: "deck", cur: card ?? (view ? "unc" : null), focused, selected, seenAvailable: changedHere > 0 || settleable,
    undo: !!undo?.live(), held: view?.held.length ?? 0, done: view?.done.length ?? 0 };
  const on = availability(context);
  const persist = useCallback(() => writeStore("sessionStorage", PLACE_KEY, placeRef.current), []);

  // The session's order grows with new cards at the end; each view gets its baseline the first time it's read, so nothing is news then.
  useEffect(() => {
    if (!view) return;
    if (place.order.join() !== order.join()) { place.order = order; persist(); }
    const missing: Record<string, ReturnType<typeof cardSnapshot>> = {};
    for (const item of view.active) {
      if (!seen.rows[item.id]) missing[item.id] = cardSnapshot(item);
      if (!seen.rows[threadsKey(item.id)]) missing[threadsKey(item.id)] = threadSnapshot(item);
    }
    if (!seen.rows.unc) missing.unc = uncSnapshot(view);
    if (Object.keys(missing).length) setSeen((current) => ({ ...current, rows: { ...current.rows, ...missing } }));
  }, [view, order, place, seen.rows, persist]);
  useEffect(() => writeStore("localStorage", SEEN_KEY, seen), [seen]);

  // ---- place: scroll anchors, flips, resizes, and focus --------------------
  /** The card the last flip landed on. */
  const shown = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (pendingAnchor.current) { restoreAnchor(pendingAnchor.current); pendingAnchor.current = null; }
    if (pendingFocus.current) { focusBack(pendingFocus.current, scrollFocus.current); pendingFocus.current = null; scrollFocus.current = false; return; }
    // The one safety net: a control that unmounted or hid under focus hands it to its replacement, never to the page.
    const active = document.activeElement;
    const gone = lastFocusElement.current && (!lastFocusElement.current.isConnected || (lastFocusElement.current as HTMLElement).offsetParent === null);
    // A flip lands focus itself, on the card's own saved row (the effect below).
    if ((!active || active === document.body) && lastFocus.current && gone && !dialog && !batch.open && !merging && shown.current === cur) focusBack(lastFocus.current);
  });
  // A flip lands on the card's saved place, then plays its motion over the stack (deck-flip.ts).
  useLayoutEffect(() => {
    if (!view || shown.current === cur) return;
    const first = shown.current === null;
    shown.current = cur;
    // A flip still playing ends first, so what follows measures where things sit, not where it draws them.
    if (viewRef.current) settleFlip(viewRef.current);
    setSlack(0);
    const saved = viewPlace(cur);
    if (scrollerRef.current) scrollerRef.current.scrollTop = saved.scrollTop;
    restoreAnchor(saved.anchor);
    liveAnchor.current = saved.anchor;
    const flipped = landing.current;
    landing.current = null;
    // Focus lands before the motion starts, for the same reason. A flip from the strip keeps focus in the strip; any other flip, or
    // arriving from another view, lands on what you can see.
    const before = document.activeElement;
    const strip = before?.closest?.("nav[aria-label=Efforts]");
    if (strip) rootRef.current?.querySelector<HTMLElement>(`[data-deck-chip="${CSS.escape(cur)}"]`)?.focus({ preventScroll: true });
    else if (!first || !document.activeElement || document.activeElement === document.body) landFocus(saved);
    chipsRef.current?.querySelector(`[data-deck-chip="${CSS.escape(cur)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (first) return;
    if (flipped && viewRef.current) playFlip(viewRef.current, flipped);
    // Screen readers hear the card once, after the last of a run of flips, and not at all when focus moved onto its heading or chip, which say it.
    const said = focusNamesCard(before, document.activeElement);
    const name = card ? card.card.name : "Unclassified";
    setAnnounce("");
    if (announceTimer.current !== null) window.clearTimeout(announceTimer.current);
    announceTimer.current = said ? null : window.setTimeout(() => setAnnounce(name), FLIP_MS);
  });
  useEffect(() => () => { if (announceTimer.current !== null) window.clearTimeout(announceTimer.current); }, []);
  // The pane resizing holds the row you were on in place, and keeps the current chip in view.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let width = scroller.clientWidth;
    const observer = new ResizeObserver(() => {
      if (scroller.clientWidth === width) return;
      width = scroller.clientWidth;
      restoreAnchor(liveAnchor.current);
      chipsRef.current?.querySelector("[aria-current=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [restoreAnchor]);
  const onScroll = useRef<number | null>(null);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const handler = () => {
      const melted = meltSlack({ scrollTop: scroller.scrollTop, slack: slack.current });
      if (melted.slack !== slack.current) { setSlack(melted.slack); scroller.scrollTop = melted.scrollTop; }
      // Where the heading is laid out, not where a flip draws it, so a flip's motion never reads as a scroll.
      const heading = viewRef.current?.querySelector<HTMLElement>("[data-deck-focus=heading]") ?? null;
      let bottom = heading?.offsetHeight ?? 0;
      for (let element = heading; element && element !== scroller; element = element.offsetParent as HTMLElement | null) bottom += element.offsetTop;
      setStuck(!!heading && bottom < scroller.scrollTop + 2);
      if (onScroll.current !== null) window.clearTimeout(onScroll.current);
      onScroll.current = window.setTimeout(() => {
        const saved = viewPlace(curRef.current);
        saved.scrollTop = scroller.scrollTop;
        saved.anchor = liveAnchor.current = captureAnchor();
        persist();
      }, 120);
    };
    scroller.addEventListener("scroll", handler, { passive: true });
    return () => scroller.removeEventListener("scroll", handler);
  });
  // Track focus inside the deck: its row, and the key that finds the control again.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onIn = (event: FocusEvent) => {
      const key = focusKey(event.target as Element);
      lastFocus.current = key;
      lastFocusElement.current = event.target as Element;
      setActiveRow(key.row ?? null);
      if (key.row) { viewPlace(curRef.current).focus = key.row; persist(); }
    };
    const onOut = (event: FocusEvent) => { if (event.relatedTarget instanceof Element && !root.contains(event.relatedTarget)) lastFocus.current = null; };
    root.addEventListener("focusin", onIn);
    root.addEventListener("focusout", onOut);
    return () => { root.removeEventListener("focusin", onIn); root.removeEventListener("focusout", onOut); };
  });

  function focusKey(element: Element | null): FocusKey {
    if (!element) return {};
    return { id: element.closest<HTMLElement>("[data-deck-focus]")?.dataset.deckFocus, row: element.closest<HTMLElement>("[data-deck-row]")?.dataset.deckRow,
      section: element.closest<HTMLElement>("[data-deck-sec]")?.dataset.deckSec };
  }
  function focusBack(key: FocusKey, reveal = false) {
    const root = rootRef.current;
    if (!root) return;
    const live = (element: HTMLElement) => element.isConnected && element.getAttribute("aria-disabled") !== "true" && !(element as HTMLButtonElement).disabled
      && element.offsetParent !== null;
    const rows = () => Array.from(root.querySelectorAll<HTMLElement>("[data-deck-row]:not([data-deck-dim])"));
    const target = focusFallback<HTMLElement>(key, {
      byId: (id) => root.querySelector(`[data-deck-focus="${CSS.escape(id)}"]`), row: (prUrl) => root.querySelector(`[data-deck-row="${CSS.escape(prUrl)}"]`),
      nextLiveRow: (section) => {
        const sections = Array.from(root.querySelectorAll<HTMLElement>("[data-deck-sec]"));
        const from = sections.findIndex((element) => element.dataset.deckSec === section);
        for (const element of from < 0 ? [] : sections.slice(from)) { const row = element.querySelector<HTMLElement>("[data-deck-row]:not([data-deck-dim])"); if (row) return row; }
        return null;
      },
      firstLiveRow: () => rows().find(inView) ?? null, heading: () => root.querySelector("[data-deck-focus=heading]"), live });
    target?.focus({ preventScroll: true });
    if (target && reveal && !inView(target)) target.scrollIntoView({ block: "nearest" });
  }
  /** After a flip or a view switch: the row you were on if it shows, else the first row in view below the card, else the card's heading. */
  function landFocus(saved: ViewPlace) {
    const root = rootRef.current;
    if (!root) return;
    const row = saved.focus ? root.querySelector<HTMLElement>(`[data-deck-row="${CSS.escape(saved.focus)}"]`) : null;
    const heading = root.querySelector<HTMLElement>("[data-deck-focus=heading]");
    const target = (row && inView(row) ? row : null) ?? (heading && inView(heading) ? heading : null)
      ?? Array.from(root.querySelectorAll<HTMLElement>("[data-deck-row]")).find(inView) ?? heading;
    target?.focus({ preventScroll: true });
  }

  // ---- small helpers -------------------------------------------------------
  const openDialog = (next: Dialogs) => {
    // A dialog opened from the palette returns where the palette came from.
    const key = focusKey(document.activeElement);
    if (key.id || key.row) opener.current = key;
    setDialogError(null); setBusy(false); setDialog(next);
  };
  const closeDialog = () => setDialog(null);
  const returnFocus = () => { pendingFocus.current = null; window.requestAnimationFrame(() => focusBack(opener.current)); };
  /** A flip lands on its card now; the card it takes away is copied first, for its motion to take away after the swap. */
  const go = (to: { step: 1 | -1 } | { id: string }) => {
    const next = flips(ring, cur, to, performance.now(), reduced());
    if (!next) return;
    viewPlace(cur).scrollTop = scrollerRef.current?.scrollTop ?? 0;
    viewPlace(cur).anchor = captureAnchor();
    landing.current = { direction: next.direction, motion: next.motion, ghost: next.motion.kind !== "none" && viewRef.current ? ghostOf(viewRef.current) : null };
    place.cur = next.id;
    setActiveRow(null);
    persist();
    bump();
  };
  const refs = (list: readonly DeckLine[]) => list.map((line) => line.ref);
  const cardOf = (id: string) => view?.active.find((item) => item.id === id) ?? view?.held.find((item) => item.id === id) ?? null;

  // ---- membership: accept, move, one-off, new effort, rules ---------------
  /** `note`: what else an Accept across groups did, said with its result so the result doesn't hide it. */
  async function classify(call: () => Promise<{ ok: true; actionId: string; effort: { name: string }; added: number } | { ok: false; error: string }>, group: string | null,
    prUrls: readonly string[], note?: string | null) {
    setBusy(true);
    let result: Awaited<ReturnType<typeof call>>;
    try { result = await call(); } catch (cause) { result = { ok: false, error: message(cause) }; }
    setBusy(false);
    if (!result.ok) { if (dialog) setDialogError(result.error); else say(result.error); return false; }
    const { actionId, effort, added } = result;
    const text = `${added} PR${added === 1 ? "" : "s"} → ${effort.name}`;
    if (group) setAccepted((current) => new Map([...current, [group, { actionId, text, prUrls }]]));
    const undoIt = async () => {
      const undone = await rpc.call("classify_undo", { actionId });
      if (undone.ok && group) setAccepted((current) => { const next = new Map(current); next.delete(group); return next; });
      say(undone.ok ? "Undone." : undone.error);
      load();
    };
    let used = false;
    setUndo({ label: text, live: () => !used, run: async () => { used = true; await undoIt(); } });
    closeDialog();
    say(note ? `${text} · ${note}` : text, true);
    if (group) nextGroupFocus(group, prUrls);
    load();
    return true;
  }
  /** After an accept, the next row left to sort takes focus where it stood: the same group's, else the next group's. A group you took all of collapses. */
  function nextGroupFocus(group: string, moved: readonly string[]) {
    const groups = unc?.groups ?? [];
    const from = Math.max(0, groups.findIndex((item) => item.key === group));
    const left = (item: UncGroup) => item.accepted ? [] : item.lines.filter((line) => !line.dim && !moved.includes(line.prUrl));
    const next = [...groups.slice(from), ...groups.slice(0, from)].find((item) => left(item).length);
    const row = next && left(next)[0];
    const element = row ? rootRef.current?.querySelector(`[data-deck-row="${CSS.escape(row.prUrl)}"]`) : null;
    pendingAnchor.current = captureAnchor(element);
    pendingFocus.current = row ? { row: row.prUrl, section: next!.key } : { id: "heading" };
    scrollFocus.current = true;
  }
  const assign = (effortId: string, prUrls: string[], group: string | null, note?: string | null) =>
    classify(() => rpc.call("classify_assign", { effortKey: effortId, prUrls }), group, prUrls, note);
  const oneOff = (prUrls: string[], group: string | null, note?: string | null) => classify(() => rpc.call("classify_one_off", { prUrls }), group, prUrls, note);
  /** `asked`: a weak group's rows you already checked in its confirm; before that, its Accept opens the confirm. `note`: see `classify`. */
  function acceptGroup(key: string, { asked, note }: { asked?: readonly DeckLine[]; note?: string | null } = {}) {
    const group = unc?.groups.find((item) => item.key === key);
    if (!group) return;
    const live = group.lines.filter((line) => !line.dim);
    const picked = live.filter((line) => here.selected.includes(line.prUrl));
    const rows = asked ?? (picked.length ? picked : live);
    if (!rows.length) return;
    if (group.button.confirm && !asked) { openDialog({ kind: "weak", group: key, lines: rows }); return; }
    const prUrls = rows.map((line) => line.prUrl);
    const target = group.target;
    if (target?.kind === "effort") void assign(target.effortId, prUrls, key, note);
    else if (target?.kind === "one-off") void oneOff(prUrls, key, note);
    else if (target?.kind === "new") openDialog({ kind: "new", prUrls, refs: refs(rows), name: target.name, goal: "", group: key });
    else {
      // No clear signal: pick an effort for the rows you selected, else for the focused row, and the dialog names exactly those.
      const chosen = picked.length ? picked : [live.find((line) => line.prUrl === activeRow) ?? live[0]!];
      openDialog({ kind: "move", prUrls: chosen.map((line) => line.prUrl), refs: refs(chosen), group: null });
    }
  }
  const scopeRows = () => selected.length ? selected : focused && !focused.dim ? [focused] : [];

  // ---- piles --------------------------------------------------------------
  async function movePile(move: "hold" | "complete" | "resume" | "reopen", effort: { id: string; key: string; name: string }, reason = "") {
    const { key: effortKey, name } = effort;
    setBusy(true);
    const leaving = move === "hold" || move === "complete";
    // Light card motion: the card on top drops toward its pile, which then bumps, and shows the stack behind it.
    const cardElement = viewRef.current?.querySelector<HTMLElement>("[data-deck-top]");
    const pileElement = rootRef.current?.querySelector<HTMLElement>(`[data-deck-pile="${move === "hold" ? "hold" : "done"}"]`);
    if (leaving && cardElement && pileElement && !reduced()) {
      const from = cardElement.getBoundingClientRect(), to = pileElement.getBoundingClientRect();
      // It shrinks about its middle, where a flip scales it about its bottom edge.
      const origin = "50% 50%";
      await cardElement.animate([{ transformOrigin: origin, transform: "none", opacity: 1 },
        { transformOrigin: origin, transform: `translate(${to.left - from.left - from.width / 2}px, ${to.top - from.top}px) scale(0.08) rotate(${move === "hold" ? -6 : 6}deg)`, opacity: 0.2 }],
        { duration: 300, easing: "cubic-bezier(.5,0,.2,1)", fill: "forwards" }).finished.catch(() => undefined);
    }
    let result: { ok: true } | { ok: false; error: string };
    try {
      result = move === "hold" ? await rpc.call("effort_hold", { effortKey, reason }) : move === "complete" ? await rpc.call("effort_complete", { effortKey })
        : move === "resume" ? await rpc.call("effort_resume", { effortKey }) : await rpc.call("effort_reopen", { effortKey });
    } catch (cause) { result = { ok: false, error: message(cause) }; }
    setBusy(false);
    cardElement?.getAnimations().forEach((animation) => animation.cancel());
    if (!result.ok) { if (dialog) setDialogError(result.error); else say(result.error); return; }
    closeDialog();
    setPile(null);
    if (!reduced()) pileElement?.animate([{ transform: "scale(1)" }, { transform: "scale(1.25)" }, { transform: "scale(1)" }], { duration: 350, easing: EASE });
    const back = move === "hold" ? "resume" : move === "complete" ? "reopen" : null;
    let used = false;
    setUndo(back ? { label: `${move} ${name}`, live: () => !used, run: async () => { used = true; await movePile(back, effort); } } : null);
    say(move === "hold" ? `Held ${name}. Its PRs stop counting until you resume it.` : move === "complete" ? `Completed ${name}.`
      : `${move === "resume" ? "Resumed" : "Reopened"} ${name}. It joins the end of the pile.`, !!back);
    if (leaving) {
      const index = order.indexOf(effort.id);
      const nextOrder = order.filter((id) => id !== effort.id);
      place.cur = nextOrder[Math.min(Math.max(0, index), nextOrder.length - 1)] ?? "unc";
    } else place.cur = effort.id;
    // The card it lands on rises out of the stack; the one that left already flew to its pile.
    if (place.cur !== cur) landing.current = { direction: 1, motion: flipMotion(reduced(), null), ghost: null };
    persist();
    bump();
    load();
  }

  // ---- Mark seen -----------------------------------------------------------
  function markSeen() {
    if (!view || !context.seenAvailable) return;
    const root = rootRef.current;
    const focusedRow = document.activeElement?.closest?.("[data-deck-row]");
    const firstChanged = Array.from(root?.querySelectorAll("[data-deck-row][data-deck-dot]") ?? []).find(inView);
    const anchor = captureAnchor(focusedRow && inView(focusedRow) ? focusedRow : firstChanged);
    const before = Array.from(root?.querySelectorAll<HTMLElement>("[data-deck-row]") ?? []).map((element) => element.dataset.deckRow!);
    const moved = lines.filter((line) => line.dot && !line.ghost && line.trail?.kind === "change").length;
    const left = lines.filter((line) => line.ghost).length;
    const stamp = Date.now();
    const settled = card ? { [card.card.id]: cardSnapshot(card.card), [threadsKey(card.card.id)]: threadSnapshot(card.card) } : { unc: uncSnapshot(view) };
    const marked = Object.fromEntries((card ? card.card.sections.flatMap((section) => section.rows) : view.unclassified.rows).map((row) => [row.prUrl, stamp]));
    setSeen((current) => ({ rows: { ...current.rows, ...settled }, at: { ...current.at, ...marked } }));
    if (!card) setAccepted(new Map());
    // The anchor row holds its pixel; if Mark seen took it away, the next row that stays takes its place.
    const from = anchor && "row" in anchor ? before.indexOf(anchor.row) : -1;
    const stays = (prUrl: string) => card ? card.card.sections.some((section) => section.rows.some((row) => row.prUrl === prUrl))
      : view.unclassified.rows.some((row) => row.prUrl === prUrl);
    const survivor = from < 0 ? null : before.slice(from).find(stays) ?? before.slice(0, from).reverse().find(stays) ?? null;
    pendingAnchor.current = anchor && "row" in anchor ? (survivor ? { row: survivor, at: anchor.at } : null) : anchor;
    const key = focusKey(document.activeElement);
    pendingFocus.current = { id: key.id === "seen" ? undefined : key.id, row: key.row && stays(key.row) ? key.row : survivor ?? undefined, section: key.section };
    setSeenNote(["Seen", moved && `${moved} moved`, left && `${left} left this view`].filter(Boolean).join(" · "));
    window.setTimeout(() => setSeenNote(null), 4_500);
  }

  // ---- selection and rows --------------------------------------------------
  const lastSelected = useRef<string | null>(null);
  function toggleSelect(prUrl: string, shift: boolean) {
    const list = here.selected;
    const visible = lines.filter((line) => !line.dim).map((line) => line.prUrl);
    if (shift && lastSelected.current && visible.includes(lastSelected.current)) {
      const [a, b] = [visible.indexOf(lastSelected.current), visible.indexOf(prUrl)].sort((x, y) => x - y);
      here.selected = [...new Set([...list, ...visible.slice(a, b + 1)])];
    } else here.selected = list.includes(prUrl) ? list.filter((item) => item !== prUrl) : [...list, prUrl];
    lastSelected.current = prUrl;
    persist();
    bump();
  }
  function moveRow(delta: number) {
    const root = rootRef.current;
    if (!root) return;
    const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-deck-row]"));
    if (!rows.length) return;
    const current = document.activeElement?.closest<HTMLElement>("[data-deck-row]");
    const at = current ? rows.indexOf(current) : -1;
    const visible = rows.filter(inView);
    const next = at < 0 ? (delta > 0 ? visible[0] : visible.at(-1)) ?? rows[0]! : rows[Math.max(0, Math.min(rows.length - 1, at + delta))]!;
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "nearest" });
  }
  const toggleIn = (list: string[], item: string) => list.includes(item) ? list.filter((value) => value !== item) : [...list, item];

  // ---- the one action runner: keys, buttons, the palette ---------------------
  function runAction(id: DeckActionId, line?: DeckLine, n?: number) {
    const row = line ?? focused;
    switch (id) {
      case "next": case "prev": go({ step: id === "next" ? 1 : -1 }); return;
      case "jump": { const target = n ? ring[n - 1] : undefined; if (target) go({ id: target }); return; }
      case "unclassified": go({ id: "unc" }); return;
      case "view": onView("prs"); return;
      case "seen": markSeen(); return;
      case "hold-pile": setPile("hold"); return;
      case "done-pile": setPile("done"); return;
      case "advance": {
        if (selected.length) void batch.plan("advance", card?.card.id ?? null, selected.map((item) => item.prUrl));
        // The rows its count names, as drawn: one dimmed until Mark seen stays out even when the server would now plan it.
        else if (card) void batch.plan("advance", card.card.id, card.advance);
        return;
      }
      case "hold": if (card) openDialog({ kind: "hold", id: card.card.id, effortKey: card.card.key, name: card.card.name, reason: "" }); return;
      case "complete": if (card) openDialog({ kind: "complete", id: card.card.id }); return;
      case "tiles": {
        const all = ["next", "blocked", "stats", "threads", "linear", "people", "recent"];
        here.tiles = all.every((tile) => here.tiles.includes(tile)) ? [] : all;
        pendingAnchor.current = captureAnchor();
        persist(); bump(); return;
      }
      case "merge": {
        const list = line ? [line] : targets("merge", context);
        if (list.length) { opener.current = focusKey(document.activeElement); setMerging(list.map((item) => ({ target: item.prUrl, n: null }))); }
        return;
      }
      case "confirm": case "nudge": case "request": case "ready": {
        const list = line ? [line] : targets(id, context);
        if (list.length) void batch.plan(KIND_OF[id]!, card?.card.id ?? null, list.map((item) => item.prUrl));
        return;
      }
      case "undo": if (undo?.live()) { const run = undo; setUndo(null); setFlash(null); void run.run(); } return;
      case "hold-pr": {
        if (!row?.row) return;
        if (row.row.hold) void rpc.call("pr_hold_set", { prUrl: row.prUrl, held: false }).then(() => { say(`Released ${row.ref}.`); load(); }, (cause: unknown) => say(message(cause)));
        else openDialog({ kind: "hold-pr", prUrl: row.prUrl, ref: row.ref, reason: "" });
        return;
      }
      case "refresh": if (row) void rpc.call("pr_refresh", { prUrl: row.prUrl }).then((read) => say(read.status === "checked" ? `Read ${row.ref} just now.` : read.error),
        (cause: unknown) => say(message(cause))); return;
      case "row-next": moveRow(1); return;
      case "row-prev": moveRow(-1); return;
      case "select": if (row && !row.dim) toggleSelect(row.prUrl, false); return;
      case "select-section": {
        if (!row) return;
        const same = lines.filter((item) => item.section === row.section && (cur === "unc" ? !item.dim : item.needs)).map((item) => item.prUrl);
        here.selected = [...new Set([...here.selected, ...same])];
        persist(); bump(); say(`Selected ${same.length} in this ${cur === "unc" ? "group" : "section"}.`); return;
      }
      case "expand": if (row) { here.expanded = toggleIn(here.expanded, row.prUrl); pendingAnchor.current = captureAnchor(); persist(); bump(); } return;
      case "clear": if (here.selected.length) { here.selected = []; persist(); bump(); } else if (row && here.expanded.includes(row.prUrl)) runAction("expand", row); return;
      case "open-thread": if (row?.row?.thread) navigate.toThread(row.row.thread.id); return;
      case "open-pr": if (row) navigate.openUrl(row.prUrl); return;
      case "accept": {
        if (!selected.length) { if (row) acceptGroup(row.section); return; }
        const plan = acceptPlan(unc?.groups ?? [], [...new Set(selected.map((item) => item.section))]);
        for (const key of plan.take) acceptGroup(key, { note: plan.left });
        if (plan.left) say(plan.left);
        return;
      }
      case "move": { const list = scopeRows(); if (list.length) openDialog({ kind: "move", prUrls: list.map((item) => item.prUrl), refs: refs(list), group: null }); return; }
      case "one-off": { const list = scopeRows(); if (list.length) void oneOff(list.map((item) => item.prUrl), null); return; }
      case "new-effort": { const list = scopeRows(); if (list.length) openDialog({ kind: "new", prUrls: list.map((item) => item.prUrl), refs: refs(list), name: "", goal: "", group: null }); return; }
      case "rule": {
        const first = view?.active.find((item) => !item.oneOff);
        openDialog({ kind: "rule", draft: { kind: "ticket-prefix", value: "", effortId: first?.id ?? "", now: true }, matches: null });
        return;
      }
      case "seed": {
        openDialog({ kind: "seed", proposals: null, keyed: true, picked: [], requestId: crypto.randomUUID() });
        void rpc.call("linear_seed_preview", null).then((result) => setDialog((current) => current?.kind === "seed" ? { ...current, ...result } : current),
          (cause: unknown) => setDialogError(message(cause)));
        return;
      }
      case "palette": openDialog({ kind: "palette", query: "", highlight: 0 }); return;
      case "help": openDialog({ kind: "help" }); return;
    }
  }
  const runRef = useRef(runAction);
  runRef.current = runAction;

  const run = (command: DeckCommand) => {
    switch (command.kind) {
      case "action": runAction(command.id, command.line); return;
      case "go": go({ id: command.id }); return;
      case "view": onView(command.view); return;
      case "select": toggleSelect(command.prUrl, command.shift); return;
      case "expand": here.expanded = toggleIn(here.expanded, command.prUrl); persist(); bump(); return;
      case "focus": setActiveRow(command.prUrl); return;
      case "tile": here.tiles = toggleIn(here.tiles, command.key); pendingAnchor.current = captureAnchor(); persist(); bump(); return;
      case "fold": here.open = toggleIn(here.open, command.key); pendingAnchor.current = captureAnchor(); persist(); bump(); return;
      case "group": acceptGroup(command.key); return;
      case "undo-group": {
        const done = accepted.get(command.key);
        if (done) void rpc.call("classify_undo", { actionId: done.actionId }).then((result) => {
          if (result.ok) setAccepted((current) => { const next = new Map(current); next.delete(command.key); return next; });
          else say(result.error);
          load();
        }, (cause: unknown) => say(message(cause)));
        return;
      }
      case "undo-batch": void rpc.call("deck_batch_undo", { batchId: command.batchId }).then((result) => { say(result.ok ? "Undone. Nothing was sent." : result.error); load(); },
        (cause: unknown) => say(message(cause))); return;
      case "thread": navigate.toThread(command.id); return;
      case "jump": {
        const element = rootRef.current?.querySelector<HTMLElement>(`[data-deck-row="${CSS.escape(command.prUrl)}"]`);
        if (!element && lines.some((line) => line.prUrl === command.prUrl && line.section === "flight")) {
          here.open = [...new Set([...here.open, "flight"])]; pendingFocus.current = { row: command.prUrl }; persist(); bump(); return;
        }
        element?.scrollIntoView({ block: "center" });
        element?.focus({ preventScroll: true });
        if (element && !reduced()) element.animate([{ background: "rgba(56,189,248,.18)" }, { background: "transparent" }], { duration: 900 });
        return;
      }
      case "resume": { const item = view?.held.find((entry) => entry.id === command.id); if (item) void movePile("resume", item); return; }
      case "reopen": { const item = view?.done.find((entry) => entry.id === command.id); if (item) void movePile("reopen", item); return; }
      case "rule-remove": void rpc.call("classify_rule_remove", { ruleId: command.id }).then((result) => { if (!result.ok) say(result.error); loadRules(); }); return;
      case "pile": setPile(command.pile); return;
    }
  };

  // The keys: one registry, only while focus is in the deck (or nowhere), and never while you type.
  useRegistryKeys(rootRef, { on: () => availability(contextRef.current), run: (id, n) => runRef.current(id, undefined, n), say,
    isRow: (target) => target.dataset.deckRow !== undefined });
  const contextRef = useRef(context);
  contextRef.current = context;

  const loadRules = useCallback(() => {
    void rpc.call("classify_get", null).then((result) => setRules(result.rules.map((rule) => ({ id: rule.id,
      text: `${RULE_WORDS[rule.kind]}${rule.kind === "stack" ? "" : ` ${rule.value}`} → ${rule.effortName ?? "its base's effort"} · ${rule.hits} this week` }))), () => undefined);
  }, [rpc]);
  const loaded = view !== null;
  useEffect(() => { if (loaded && cur === "unc") loadRules(); }, [loaded, cur, loadRules]);
  // A rule's preview counts the PRs it would place now, before you add it.
  const ruleDraft = dialog?.kind === "rule" ? dialog.draft : null;
  useEffect(() => {
    if (!ruleDraft || (ruleDraft.kind !== "stack" && !ruleDraft.value.trim())) return;
    let live = true;
    const timer = window.setTimeout(() => void rpc.call("classify_rule_preview", { kind: ruleDraft.kind, value: ruleDraft.value.trim(),
      effortKey: ruleDraft.kind === "stack" ? null : ruleDraft.effortId }).then((result) => {
      if (live) setDialog((current) => current?.kind === "rule" ? { ...current, matches: result.ok ? result.prUrls.length : null } : current);
    }, () => undefined), 250);
    return () => { live = false; window.clearTimeout(timer); };
  }, [ruleDraft?.kind, ruleDraft?.value, ruleDraft?.effortId, rpc]);

  // ---- render ----------------------------------------------------------------
  const pileItems = {
    held: (view?.held ?? []).map((item) => ({ id: item.id, key: item.key, name: item.name, note: `${item.reason || "No reason given"} · ${item.stats.open} open` })),
    done: (view?.done ?? []).map((item) => ({ id: item.id, key: item.key, name: item.name, archived: item.archived, note: `${item.merged} merged · ${item.open} open` })),
  };
  const palette = paletteItems(on, chips, pileItems, cur, true);
  const runPalette = (item: PaletteItem) => {
    closeDialog();
    // The palette's action runs once its dialog has handed focus back, so a confirm it opens takes focus from there.
    window.setTimeout(() => {
      if (item.action) runAction(item.action.id);
      else if (item.target?.kind === "go") go({ id: item.target.id });
      else if (item.target) run({ kind: item.target.kind, id: item.target.id });
    }, 0);
  };
  const kinds = (["merge", "confirm", "nudge", "request", "ready"] as const).flatMap((id) => {
    const count = selected.filter((line) => line.needs && line.section === id).length;
    return count ? [{ id, count, tone: SECTIONS[id].tone }] : [];
  });
  const complete = dialog?.kind === "complete" ? cardOf(dialog.id) : null;
  const weakGroup = dialog?.kind === "weak" ? unc?.groups.find((item) => item.key === dialog.group) ?? null : null;
  const matches = dialog?.kind === "palette" ? paletteMatch(palette, dialog.query) : [];
  const moveTargets = [...order.flatMap((id) => { const item = cards.get(id); return item ? [{ id, name: item.card.name, color: item.color, open: item.card.stats.open }] : []; })];

  return <>
    <DeckPane chips={chips} cur={cur} card={card} unc={card ? null : unc} rules={rules} held={pileItems.held} done={pileItems.done} pile={pile} announce={announce}
      read={{ text: view ? readText(view, now) : "Reading…", error }}
      seen={{ changed: changedHere, available: context.seenAvailable, note: seenNote }}
      state={{ selected: new Set(here.selected), expanded: new Set(here.expanded), focus: here.focus }} tiles={new Set(here.tiles)} open={new Set(here.open)} stuck={stuck}
      on={on} hints={hintKeys(context, on)} flash={flash} batch={{ kinds }} run={run} onPalette={() => runAction("palette")} onHelp={() => runAction("help")}
      onUndo={() => runAction("undo")} rootRef={rootRef} scrollerRef={scrollerRef} slackRef={slackRef} viewRef={viewRef} chipsRef={chipsRef} />
    {batch.element}
    <DeckDialog open={dialog?.kind === "hold" || dialog?.kind === "hold-pr"} title={dialog?.kind === "hold" ? `Hold ${dialog.name}` : dialog?.kind === "hold-pr" ? `Hold ${dialog.ref}` : ""}
      sub={dialog?.kind === "hold" ? "It leaves the active pile. Its PRs stay open and stop counting; nothing acts on them until you resume it."
        : "Nothing acts on this PR, and no batch writes to it, until you release it."}
      onClose={closeDialog} onReturn={returnFocus} onConfirmKey={() => holdNow()}>
      {dialog?.kind === "hold" || dialog?.kind === "hold-pr" ? <HoldBody reason={dialog.reason} onReason={(value) => setDialog({ ...dialog, reason: value })} busy={busy}
        error={dialogError} onHold={() => holdNow()} onCancel={closeDialog} /> : null}
    </DeckDialog>
    <DeckDialog open={!!complete} title={complete ? `Complete ${complete.name}?` : ""} sub="Still open first:" onClose={closeDialog} onReturn={returnFocus}
      onConfirmKey={() => { if (complete) void movePile("complete", complete); }}>
      {complete ? <CompleteBody screen={cards.get(complete.id) ?? cardScreen(complete, seen, { now })} busy={busy} error={dialogError}
        onComplete={() => void movePile("complete", complete)} onCancel={closeDialog} /> : null}
    </DeckDialog>
    <DeckDialog open={dialog?.kind === "rule"} title="Add a standing rule" sub="Applies to new PRs on every read. Remove it any time; the PRs it placed stay."
      onClose={closeDialog} onReturn={returnFocus} onConfirmKey={() => addRule()}>
      {dialog?.kind === "rule" ? <RuleBody draft={dialog.draft} efforts={moveTargets} matches={dialog.matches} busy={busy} error={dialogError}
        onDraft={(draft) => setDialog({ ...dialog, draft })} onAdd={() => addRule()} onCancel={closeDialog} /> : null}
    </DeckDialog>
    <DeckDialog open={dialog?.kind === "new"} title="New effort" sub="A new card joins the end of the pile. You stay where you are." onClose={closeDialog} onReturn={returnFocus}
      onConfirmKey={() => createEffort()}>
      {dialog?.kind === "new" ? <NewEffortBody name={dialog.name} goal={dialog.goal} refs={dialog.refs} busy={busy} error={dialogError}
        onName={(value) => setDialog({ ...dialog, name: value })} onGoal={(value) => setDialog({ ...dialog, goal: value })} onCreate={() => createEffort()} onCancel={closeDialog} /> : null}
    </DeckDialog>
    <DeckDialog open={dialog?.kind === "move"} title={dialog?.kind === "move" ? `Move ${dialog.prUrls.length} PR${dialog.prUrls.length === 1 ? "" : "s"} to` : ""}
      onClose={closeDialog} onReturn={returnFocus}>
      {dialog?.kind === "move" ? <MoveBody refs={dialog.refs} busy={busy} error={dialogError}
        efforts={moveTargets} onMove={(effortId) => void assign(effortId, dialog.prUrls, dialog.group)}
        onNew={() => setDialog({ kind: "new", prUrls: dialog.prUrls, refs: dialog.refs, name: "", goal: "", group: dialog.group })} /> : null}
    </DeckDialog>
    <DeckDialog open={dialog?.kind === "seed"} title="Seed efforts from Linear" sub="One effort per Linear project on your open PRs. Check the ones to create."
      onClose={closeDialog} onReturn={returnFocus} onConfirmKey={() => seed()}>
      {dialog?.kind === "seed" ? <SeedBody proposals={dialog.proposals} keyed={dialog.keyed} picked={new Set(dialog.picked)} busy={busy} error={dialogError}
        onPick={(projectId) => setDialog({ ...dialog, picked: toggleIn(dialog.picked, projectId) })} onCreate={() => seed()} onCancel={closeDialog} /> : null}
    </DeckDialog>
    <DeckDialog open={dialog?.kind === "weak"} title="Weak suggestion" sub={weakGroup ? `Only weak signals point ${dialog?.kind === "weak" && dialog.lines.length === 1 ? "this"
      : "these"} at ${weakGroup.title}. Check each first.` : undefined} onClose={closeDialog} onReturn={returnFocus} onConfirmKey={() => acceptWeak()}>
      {dialog?.kind === "weak" && weakGroup ? <WeakBody lines={dialog.lines} label={acceptLabel(weakGroup.target, dialog.lines.length)} busy={busy} error={dialogError}
        onAccept={() => acceptWeak()} onCancel={closeDialog} /> : null}
    </DeckDialog>
    <DeckDialog open={dialog?.kind === "palette"} title="All actions" bare onClose={closeDialog} onReturn={returnFocus}>
      {dialog?.kind === "palette" ? <div onKeyDown={(event) => {
        const live = matches.filter((item) => item.on);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setDialog({ ...dialog, highlight: Math.max(0, Math.min(live.length - 1, dialog.highlight + (event.key === "ArrowDown" ? 1 : -1))) });
        } else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) { event.preventDefault(); const item = live[dialog.highlight]; if (item) runPalette(item); }
        else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); closeDialog(); }
      }}><PaletteBody query={dialog.query} items={matches} highlight={dialog.highlight} onQuery={(query) => setDialog({ ...dialog, query, highlight: 0 })}
        onRun={runPalette} onHighlight={(highlight) => setDialog({ ...dialog, highlight })} /></div> : null}
    </DeckDialog>
    <DeckDialog open={dialog?.kind === "help"} wide closeKey="?" title="Keys and colors" sub="The same keys do the same thing in Efforts and All PRs. Grayed keys don't apply here."
      onClose={closeDialog} onReturn={returnFocus}>
      {dialog?.kind === "help" ? <HelpBody items={palette} /> : null}
    </DeckDialog>
    <MergePreviewDialog targets={merging} onClose={() => setMerging(null)} onMerged={load} onOpenUrl={(url) => navigate.openUrl(url)} onClosed={returnFocus}
      rows={(merging ?? []).flatMap(({ target }) => { const row = lines.find((line) => line.prUrl === target)?.row; return row ? [{ target, repo: row.repo, number: row.number, title: row.title }] : []; })} />
  </>;

  function holdNow() {
    if (dialog?.kind === "hold") void movePile("hold", { id: dialog.id, key: dialog.effortKey, name: dialog.name }, dialog.reason.trim());
    if (dialog?.kind === "hold-pr" && !busy) {
      setBusy(true);
      void rpc.call("pr_hold_set", { prUrl: dialog.prUrl, held: true, reason: dialog.reason.trim() || undefined }).then(() => { setBusy(false); closeDialog(); say(`Held ${dialog.ref}.`); load(); },
        (cause: unknown) => { setBusy(false); setDialogError(message(cause)); });
    }
  }
  function addRule() {
    if (dialog?.kind !== "rule" || busy) return;
    const { draft } = dialog;
    setBusy(true);
    void rpc.call("classify_rule_add", { kind: draft.kind, value: draft.value.trim(), effortKey: draft.kind === "stack" ? null : draft.effortId, now: draft.now }).then((result) => {
      setBusy(false);
      if (!result.ok) { setDialogError(result.error); return; }
      closeDialog();
      const placed = result.actions.reduce((sum, action) => sum + action.added, 0);
      const text = placed ? `Rule added; it placed ${placed} PR${placed === 1 ? "" : "s"} now.` : "Rule added.";
      // Undo takes the rule back with every PR it placed now.
      let used = false;
      setUndo({ label: text, live: () => !used, run: async () => {
        used = true;
        const errors: string[] = [];
        try {
          for (const action of result.actions) { const undone = await rpc.call("classify_undo", { actionId: action.actionId }); if (!undone.ok) errors.push(undone.error); }
          const removed = await rpc.call("classify_rule_remove", { ruleId: result.rule.id });
          if (!removed.ok) errors.push(removed.error);
        } catch (cause) { errors.push(message(cause)); }
        say(errors[0] ?? "Undone.");
        loadRules();
        load();
      } });
      say(text, true);
      loadRules();
      load();
    }, (cause: unknown) => { setBusy(false); setDialogError(message(cause)); });
  }
  /** Each seeded effort is one classification, so Undo takes all of them back together. */
  function seed() {
    if (dialog?.kind !== "seed" || busy || !dialog.picked.length) return;
    setBusy(true);
    void rpc.call("linear_seed_create", { projectIds: dialog.picked, requestId: dialog.requestId }).then((result) => {
      setBusy(false);
      if (!result.ok) { setDialogError(result.error); return; }
      closeDialog();
      const made = result.created.map((item) => item.effort.name);
      const skipped = result.skipped.map((item) => `${item.name}: ${item.reason}`);
      const text = [made.length ? `Created ${made.join(", ")}` : "Created nothing", ...skipped.length ? [`skipped ${skipped.join("; ")}`] : []].join(" · ");
      let used = false;
      setUndo(made.length ? { label: text, live: () => !used, run: async () => {
        used = true;
        let error: string | null = null;
        for (const item of result.created) { const undone = await rpc.call("classify_undo", { actionId: item.actionId }); if (!undone.ok) error = undone.error; }
        say(error ?? "Undone.");
        load();
      } } : null);
      say(text, made.length > 0);
      load();
    }, (cause: unknown) => { setBusy(false); setDialogError(message(cause)); });
  }
  function acceptWeak() {
    if (dialog?.kind === "weak" && !busy) acceptGroup(dialog.group, { asked: dialog.lines });
  }
  function createEffort() {
    if (dialog?.kind !== "new" || busy || !dialog.name.trim()) return;
    const { prUrls, name, goal, group } = dialog;
    void classify(() => rpc.call("classify_new_effort", { name: name.trim(), goal: goal.trim(), prUrls, requestId: crypto.randomUUID() }), group, prUrls);
  }
}

