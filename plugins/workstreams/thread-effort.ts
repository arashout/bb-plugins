import { z } from "zod";

export const threadEffortSourceSchema = z.object({
  id: z.string(), kind: z.enum(["ticket", "pr"]), label: z.string(), ticket: z.string().nullable(),
  prUrls: z.array(z.string()), checkoutPaths: z.array(z.string()), effortKey: z.string().nullable(),
  effortName: z.string().nullable(), explicit: z.boolean(), scope: z.string(),
});
export const threadEffortContextSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(false), error: z.string() }),
  z.object({ ok: z.literal(true), sources: z.array(threadEffortSourceSchema),
    efforts: z.array(z.object({ key: z.string(), name: z.string(), scope: z.string() })),
    linkablePrs: z.array(z.object({ url: z.string(), label: z.string() })), linkedPrUrl: z.string().nullable(),
    threadEffort: z.object({ key: z.string(), name: z.string() }).nullable(),
    inheritanceNotice: z.string().nullable() }),
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
