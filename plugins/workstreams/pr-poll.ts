/** A shared cadence for visible views. Priority work cannot starve the remaining PRs. */
export function createPrPoll(options: { now: () => number; intervalMs: number; batchSize: number }) {
  let lastAt: number | null = null;
  let cursor = 0;
  let priorityCursor = 0;
  return {
    select(openUrls: readonly string[], priorityUrls: readonly string[]): string[] {
      const now = options.now();
      if (lastAt !== null && now - lastAt < options.intervalMs) return [];
      lastAt = now;
      const known = [...new Set(openUrls)].sort();
      if (known.length === 0) return [];
      const wanted = new Set(priorityUrls);
      const priority = known.filter((url) => wanted.has(url));
      const ordinary = known.filter((url) => !wanted.has(url));
      const limit = options.batchSize;
      const priorityLimit = ordinary.length === 0 ? limit : Math.ceil(limit / 2);
      const selected = Array.from({ length: Math.min(priorityLimit, priority.length) }, (_, index) =>
        priority[(priorityCursor + index) % priority.length]!);
      if (priority.length > 0) priorityCursor = (priorityCursor + selected.length) % priority.length;
      const slots = limit - selected.length;
      for (let index = 0; index < Math.min(slots, ordinary.length); index++)
        selected.push(ordinary[(cursor + index) % ordinary.length]!);
      if (ordinary.length > 0) cursor = (cursor + Math.min(slots, ordinary.length)) % ordinary.length;
      // With few ordinary PRs, use spare capacity for priority PRs.
      for (let index = 0; selected.length < limit && index < priority.length - Math.min(priorityLimit, priority.length); index++)
        selected.push(priority[(priorityCursor + index) % priority.length]!);
      return selected;
    },
  };
}
