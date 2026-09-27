import { z } from "zod";

export const cardEffortTargetSchema = z.union([
  z.object({ prUrl: z.string().min(1).max(500) }).strict(),
  z.object({ path: z.string().min(1).max(1_000) }).strict(),
]);
export type CardEffortTarget = z.infer<typeof cardEffortTargetSchema>;

export const cardEffortContextSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(false), error: z.string() }),
  z.object({ ok: z.literal(true), source: z.object({
    id: z.string(), kind: z.enum(["ticket", "pr", "checkout"]), label: z.string(), ticket: z.string().nullable(),
    prUrls: z.array(z.string()), checkoutPaths: z.array(z.string()), effortKey: z.string().nullable(),
    effortName: z.string().nullable(), explicit: z.boolean(), scope: z.string(),
  }), affected: z.object({ tickets: z.array(z.string()), prUrls: z.array(z.string()), checkoutPaths: z.array(z.string()) }),
    prTitles: z.record(z.string(), z.string().max(300)),
    efforts: z.array(z.object({ key: z.string(), name: z.string(), scope: z.string() })),
    canMove: z.boolean(), notice: z.string().nullable() }),
]);
export type CardEffortContext = z.infer<typeof cardEffortContextSchema>;
export type CardEffortReady = Extract<CardEffortContext, { ok: true }>;

/** Selected ownership, discovered cohort, and destination must still match at write time. */
export function cardEffortMoveScope(context: CardEffortReady, destinationKey: string): string {
  const destination = context.efforts.find((effort) => effort.key === destinationKey);
  if (!context.canMove || !destination) return "";
  return JSON.stringify({ source: context.source.scope, affected: context.affected,
    destination: [destination.key, destination.scope] });
}
