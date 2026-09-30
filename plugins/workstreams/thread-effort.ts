import { z } from "zod";

export const threadEffortSourceSchema = z.object({
  id: z.string(), kind: z.enum(["ticket", "pr"]), label: z.string(), ticket: z.string().nullable(),
  prUrls: z.array(z.string()), checkoutPaths: z.array(z.string()), effortKey: z.string().nullable(),
  effortName: z.string().nullable(), explicit: z.boolean(), scope: z.string(),
});
/**
 * What the composer's effort chip and its popover show (plan amendment A17.2), read with the context. The chip names the effort the
 * thread is in; each choice is an effort the deck draws a card for, with the strongest signal when one points the thread at it; and
 * `linked` lists the PRs the thread links through its own work: its recorded PRs and the PR in its exact checkout, which its effort takes
 * in, never one it reaches only by branch name or worked path.
 */
export const threadEffortPickerSchema = z.object({
  chip: z.object({
    /** An effort: the thread's own, the one it coordinates, or the one its linked PRs are in. A service: no effort, so its linked PRs' repository. */
    kind: z.enum(["effort", "service", "none"]),
    effortId: z.string().nullable(), name: z.string(), oneOff: z.boolean(),
    /** Needs you on the effort's card; 0 for a service, whose PRs count as to sort, never as Needs you. */
    needsYou: z.number(),
    /** The deck card it opens: an effort's id, "unc" for a service's PRs still to sort, or null. */
    card: z.string().nullable(),
  }).strict(),
  choices: z.array(z.object({ key: z.string(), id: z.string(), name: z.string(), oneOff: z.boolean(), held: z.boolean(), needsYou: z.number(),
    /** The strongest signal that points the thread at it, and the signals' summed weight; null and 0 when none does. */
    signal: z.string().nullable(), score: z.number() }).strict()),
  linked: z.array(z.object({ url: z.string(), ref: z.string(), title: z.string(), effortId: z.string().nullable(), effortName: z.string().nullable(),
    /** The linked work a move takes along: the PR's ticket, and any ticket that shares one of its PRs. */
    sourceIds: z.array(z.string()),
    /** What else that move takes, for its confirm: the other PRs and tickets, and "N checkouts" an effort has. Empty when it takes only the PR and its tickets. */
    also: z.array(z.string()) }).strict()),
  /** A TypeSafe key is set, so Jev can suggest on request. */
  jev: z.boolean(),
}).strict();
export type ThreadEffortPicker = z.infer<typeof threadEffortPickerSchema>;
export const threadEffortContextSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(false), error: z.string() }),
  z.object({ ok: z.literal(true), sources: z.array(threadEffortSourceSchema),
    efforts: z.array(z.object({ key: z.string(), name: z.string(), scope: z.string() })),
    linkablePrs: z.array(z.object({ url: z.string(), label: z.string() })), linkedPrUrl: z.string().nullable(),
    threadEffort: z.object({ key: z.string(), name: z.string() }).nullable(),
    inheritanceNotice: z.string().nullable(),
    /** Only thread_effort_context reads it; a change returns the context without it. */
    picker: threadEffortPickerSchema.optional(),
    /** What a change returns for thread_effort_undo to take it back. */
    undoId: z.string().optional() }),
]);
export type ThreadEffortContext = z.infer<typeof threadEffortContextSchema>;
export type ThreadEffortReady = Extract<ThreadEffortContext, { ok: true }>;

/** Scope only the selected work and destination; unrelated scans do not invalidate a move. */
export function threadEffortMoveScope(context: ThreadEffortReady, sourceIds: readonly string[], destinationKey: string): string {
  const destination = context.efforts.find((effort) => effort.key === destinationKey);
  const ids = [...new Set(sourceIds)].sort();
  if (!destination || ids.length === 0 || ids.some((id) => !context.sources.some((source) => source.id === id))) return "";
  return JSON.stringify({ sources: ids.map((id) => [id, context.sources.find((source) => source.id === id)!.scope]),
    destination: [destination.key, destination.scope] });
}

/** A thread assignment changes only when its selected destination or previous intent changes. */
export function threadEffortAssignmentScope(context: ThreadEffortReady, destinationKey: string | null): string {
  const destination = destinationKey === null ? null : context.efforts.find((effort) => effort.key === destinationKey);
  if (destinationKey !== null && !destination) return "";
  return JSON.stringify({ prior: context.threadEffort?.key ?? null,
    destination: destination === null ? null : [destination!.key, destination!.scope] });
}

/** How much each kind of signal weighs, as the classifier weighs its own (effort-classify.ts); a classifier suggestion weighs its confidence. */
const WEIGHT = { work: 3, title: 3, parent: 2 } as const;
const CONFIDENCE_WEIGHT = { high: 3, medium: 2, low: 1 } as const;
const KIND_ORDER = ["work", "title", "classifier", "parent"] as const;

/**
 * Why a thread belongs to each effort, from what the board already knows: an effort holds a PR the thread links through its own work, a
 * ticket the thread's title names, or the thread's parent, or the classifier suggests the effort for one of its linked PRs no effort has.
 * Each kind counts once per effort. The most weight first, then the strongest one signal, then by name; nothing here moves anything.
 */
export function threadEffortSignals(input: {
  efforts: readonly { id: string; name: string }[];
  /** PRs the thread links through its own work, with the effort each is in. */
  linked: readonly { ref: string; effortId: string | null }[];
  /** Tickets the thread's title names, with the effort that has each or its PRs. */
  titleTickets: readonly { ticket: string; effortId: string | null }[];
  /** The effort the thread's parent thread is in. */
  parentEffortId: string | null;
  /** The classifier's suggestion for each linked PR no effort has, with its strongest signal. */
  classified: readonly { effortId: string; confidence: keyof typeof CONFIDENCE_WEIGHT; signal: string }[];
}): { id: string; score: number; signal: string }[] {
  const found = new Map<string, Map<(typeof KIND_ORDER)[number], { weight: number; text: string }>>();
  const add = (effortId: string | null, kind: (typeof KIND_ORDER)[number], weight: number, text: string) => {
    if (!effortId) return;
    const kinds = found.get(effortId) ?? new Map();
    if ((kinds.get(kind)?.weight ?? 0) < weight) kinds.set(kind, { weight, text });
    found.set(effortId, kinds);
  };
  const owned = new Map<string, string[]>();
  for (const pr of input.linked) if (pr.effortId) owned.set(pr.effortId, [...owned.get(pr.effortId) ?? [], pr.ref]);
  for (const [id, refs] of owned) add(id, "work", WEIGHT.work, refs.length === 1 ? `has ${refs[0]}` : `has ${refs.length} linked PRs`);
  for (const { ticket, effortId } of input.titleTickets) add(effortId, "title", WEIGHT.title, `${ticket} in the title`);
  add(input.parentEffortId, "parent", WEIGHT.parent, "parent thread's effort");
  for (const item of input.classified) add(item.effortId, "classifier", CONFIDENCE_WEIGHT[item.confidence], item.signal);
  const names = new Map(input.efforts.map((effort) => [effort.id, effort.name]));
  return [...found].flatMap(([id, kinds]) => {
    if (!names.has(id)) return [];
    const strongest = KIND_ORDER.flatMap((kind) => kinds.get(kind) ?? []).sort((a, b) => b.weight - a.weight)[0]!;
    return [{ id, score: [...kinds.values()].reduce((sum, item) => sum + item.weight, 0), signal: strongest.text, top: strongest.weight }];
  }).sort((a, b) => b.score - a.score || b.top - a.top || names.get(a.id)!.localeCompare(names.get(b.id)!)).map(({ top: _, ...item }) => item);
}

/** A repository's service effort, where its PRs and threads that no effort has fall back to (A17.1). */
export const serviceName = (repo: string) => `${repo.split("/").at(-1) ?? repo} · service`;

/**
 * The effort a thread's chip names. Explicit efforts win: the thread's own, then the one whose parent thread it is, then the one most of
 * its linked PRs are in. Without one, the repository most of its linked PRs are in, as that repository's service effort; ties go by name.
 */
export function threadEffortChip(input: {
  own: { id: string; name: string; oneOff: boolean } | null;
  coordinates: { id: string; name: string; oneOff: boolean } | null;
  /** Its linked PRs, each with its repository and the effort it's in. */
  linked: readonly { repo: string; effort: { id: string; name: string; oneOff: boolean } | null }[];
  /** Needs you on the effort's card; null when the deck draws no card for it. */
  needsYou: (effortId: string) => number | null;
}): ThreadEffortPicker["chip"] {
  const most = <T>(items: readonly T[], key: (item: T) => string, name: (item: T) => string): T | null => {
    const counts = new Map<string, { item: T; n: number }>();
    for (const item of items) counts.set(key(item), { item, n: (counts.get(key(item))?.n ?? 0) + 1 });
    return [...counts.values()].sort((a, b) => b.n - a.n || name(a.item).localeCompare(name(b.item)))[0]?.item ?? null;
  };
  const efforts = input.linked.flatMap((pr) => pr.effort ? [pr.effort] : []);
  const effort = input.own ?? input.coordinates ?? most(efforts, (item) => item.id, (item) => item.name);
  if (effort) {
    const needs = input.needsYou(effort.id);
    return { kind: "effort", effortId: effort.id, name: effort.name, oneOff: effort.oneOff, needsYou: needs ?? 0, card: needs === null ? null : effort.id };
  }
  const repo = most(input.linked.map((pr) => pr.repo.toLowerCase()), (item) => item, (item) => item);
  // Its PRs are to sort (A15), so a service counts none as Needs you.
  if (repo) return { kind: "service", effortId: null, name: serviceName(repo), oneOff: false, needsYou: 0, card: "unc" };
  return { kind: "none", effortId: null, name: "No effort", oneOff: false, needsYou: 0, card: null };
}
