/** Explicit execution choices for every thread started by Workstreams. */
export const SOL_HIGH = { providerId: "codex", model: "gpt-6-sol", reasoningLevel: "high" } as const;
export const SOL_MEDIUM = { providerId: "codex", model: "gpt-6-sol", reasoningLevel: "medium" } as const;

/** A thread's provider is fixed at creation; changing its model cannot migrate it. */
export function requireSolProvider(thread: { providerId: string }): void {
  if (thread.providerId !== "codex") {
    throw new Error("This thread uses another provider. Choose New agent to start a Sol thread; its history stays available.");
  }
}
