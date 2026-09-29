// The effort deck as a stack of cards: what lies behind the card shown and
// where each card behind it sits. The ring is the strip's order, the active
// pile and then Unclassified, so the card behind the top one is the one ]
// flips to. This module imports nothing, so the browser bundle can use it.

/** Each depth's offset and scale about its bottom edge: 0 is the card on top, and 1–3 peek out below it, each lower, to the right, and smaller. */
export const LAYERS = [{ x: 0, y: 0, scale: 1 }, { x: 3, y: 16, scale: 0.98 }, { x: 6, y: 22, scale: 0.96 }, { x: 9, y: 27, scale: 0.94 }] as const;
export const layerTransform = (depth: number) => {
  const at = LAYERS[Math.min(depth, LAYERS.length - 1)]!;
  return depth ? `translate(${at.x}px, ${at.y}px) scale(${at.scale})` : "none";
};

/** The cards behind `cur`, in the order a flip forward reaches them, wrapping, at most three and never `cur` itself. */
export function behind<T extends { id: string }>(ring: readonly T[], cur: string | null, max = LAYERS.length - 1): T[] {
  const at = ring.findIndex((item) => item.id === cur);
  if (at < 0) return [];
  return Array.from({ length: Math.min(max, ring.length - 1) }, (_, index) => ring[(at + index + 1) % ring.length]!);
}
