import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalPrUrl } from "./pr-holds.js";
import { prSchema } from "./contract.js";
import type { RunDb } from "./runstore.js";

const prUrlSchema = z.string().max(500).refine((value) => canonicalPrUrl(value) !== null, "Choose a valid GitHub PR URL");
export const conversationScopeSchema = z.array(prUrlSchema).min(1).max(100);
export const conversationExclusionSchema = z.object({ prUrl: prUrlSchema, reason: z.string().trim().min(1).max(500) }).strict();
export const conversationProposalSchema = z.object({
  revision: z.number().int().positive(), selectedPrUrls: z.array(prUrlSchema).max(100),
  instruction: z.string().max(4_000), exclusions: z.array(conversationExclusionSchema).max(100),
  previewToken: z.string().uuid().nullable(), previewExpiresAt: z.number().nullable(),
}).strict();
export const workConversationSchema = z.object({
  id: z.string().uuid(), scopePrUrls: conversationScopeSchema, threadId: z.string().nullable(),
  projectId: z.string(), revision: z.number().int().nonnegative(),
  proposal: conversationProposalSchema.nullable(), batchIds: z.array(z.string().uuid()),
  createdAt: z.number(), updatedAt: z.number(),
}).strict();
export const conversationScopeItemSchema = z.object({
  prUrl: z.string(), title: z.string().nullable(), repo: z.string().nullable(), number: z.number().nullable(),
  state: z.enum(["OPEN", "CLOSED", "MERGED", "unknown"]), hold: z.string().nullable(),
  pr: prSchema.nullable(), stage: z.string().nullable(), blocker: z.string().nullable(), nextStep: z.string().nullable(),
  observation: z.object({ checkedAt: z.string().nullable(), failedAt: z.string().nullable() }).nullable(),
  linkedThreadIds: z.array(z.string()).max(20),
  advanceStatus: z.string().nullable(), selected: z.boolean(), exclusionReason: z.string().nullable(),
}).strict();
export type WorkConversation = z.infer<typeof workConversationSchema>;
export type ConversationExclusion = z.infer<typeof conversationExclusionSchema>;
export type ConversationScopeItem = z.infer<typeof conversationScopeItemSchema>;

export const WORK_CONVERSATION_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS work_conversations (id TEXT PRIMARY KEY, scope_key TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, body TEXT NOT NULL)`,
];

export function canonicalConversationScope(urls: readonly string[]): string[] {
  const canonical = urls.map((url) => canonicalPrUrl(url));
  if (canonical.length < 1 || canonical.length > 100 || canonical.some((url) => url === null)) {
    throw new Error("Select between 1 and 100 valid GitHub PRs.");
  }
  const scope = [...new Set(canonical as string[])].sort();
  if (scope.length !== canonical.length) throw new Error("The selection contains duplicate PRs.");
  return scope;
}

export function validateConversationProposal(scope: readonly string[], selected: readonly string[], exclusions: readonly ConversationExclusion[]): void {
  if (selected.length > scope.length || new Set(selected).size !== selected.length) {
    throw new Error("Propose distinct PRs from this conversation.");
  }
  const allowed = new Set(scope);
  if (selected.some((url) => !allowed.has(url))) throw new Error("A proposed PR is outside this conversation's original scope.");
  const excluded = new Set<string>();
  for (const entry of exclusions) {
    if (!allowed.has(entry.prUrl) || excluded.has(entry.prUrl) || selected.includes(entry.prUrl)) {
      throw new Error("Exclusions must identify each skipped PR exactly once.");
    }
    excluded.add(entry.prUrl);
  }
  if (selected.length + excluded.size !== scope.length) throw new Error("Explain why every PR excluded from this proposal is skipped.");
}

export function createWorkConversationStore(db: RunDb, now = Date.now) {
  const scopeKey = (scope: readonly string[]) => createHash("sha256").update(JSON.stringify(scope)).digest("hex");
  const parse = (row: unknown): WorkConversation | null => row === undefined ? null : workConversationSchema.parse(JSON.parse((row as { body: string }).body));
  const get = (id: string) => parse(db.prepare("SELECT body FROM work_conversations WHERE id = ?").get(id));
  const byScope = (scope: readonly string[]) => {
    const found = parse(db.prepare("SELECT body FROM work_conversations WHERE scope_key = ?").get(scopeKey(scope)));
    if (found && JSON.stringify(found.scopePrUrls) !== JSON.stringify(scope)) throw new Error("Conversation scope identity collision");
    return found;
  };
  const update = (record: WorkConversation, expectedRevision: number): WorkConversation => {
    const next = workConversationSchema.parse({ ...record, revision: expectedRevision + 1, updatedAt: now() });
    const result = db.prepare("UPDATE work_conversations SET revision = ?, body = ? WHERE id = ? AND revision = ?")
      .run(next.revision, JSON.stringify(next), record.id, expectedRevision) as { changes?: number };
    if (result.changes !== 1) throw new Error("Conversation changed. Reload it before trying again.");
    return next;
  };
  return {
    get, byScope, update,
    create(scope: string[], projectId: string): { record: WorkConversation; created: boolean } {
      const existing = byScope(scope);
      if (existing) return { record: existing, created: false };
      const record = workConversationSchema.parse({ id: randomUUID(), scopePrUrls: scope, threadId: null,
        projectId, revision: 0, proposal: null, batchIds: [], createdAt: now(), updatedAt: now() });
      try { db.prepare("INSERT INTO work_conversations (id, scope_key, revision, body) VALUES (?, ?, ?, ?)")
        .run(record.id, scopeKey(scope), 0, JSON.stringify(record)); }
      catch (error) {
        const raced = byScope(scope);
        if (raced) return { record: raced, created: false };
        throw error;
      }
      return { record, created: true };
    },
  };
}
