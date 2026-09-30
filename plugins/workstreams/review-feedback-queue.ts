import { useCallback, useEffect, useRef, useState } from "react";

export type FeedbackItem = {
  key: string;
  rule: string;
  state: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  reason: string;
  updatedAt: string;
  threadId?: string;
};

type QueueResponse = { ok: true; result: { items: FeedbackItem[] } };
type StartResponse = { ok: true; result: { item: FeedbackItem } };

async function call<T>(method: string, input: unknown): Promise<T> {
  const response = await fetch(`/api/v1/plugins/review-watch/rpc/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), credentials: "same-origin",
  });
  const body = await response.json() as T & { ok?: boolean; error?: string | { message?: string } };
  if (!response.ok || !body.ok) throw new Error(typeof body.error === "string" ? body.error : body.error?.message || `Reviews request failed (${response.status})`);
  return body;
}

export const feedbackItems = (items: readonly FeedbackItem[]) => {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (item.rule !== "feedback-to-address" || item.state !== "queued") return false;
    const key = `${item.repo.toLowerCase()}#${item.number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export async function startFeedback(key: string): Promise<FeedbackItem> {
  return (await call<StartResponse>("item_start", { key })).result.item;
}

/** Reviews owns the classifier. Workstreams only reads its queued feedback. */
export function useFeedbackQueue() {
  const [items, setItems] = useState<FeedbackItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reading = useRef(false);
  const again = useRef(false);
  const load = useCallback(function read(): void {
    if (reading.current) { again.current = true; return; }
    reading.current = true;
    void call<QueueResponse>("queue_list", null).then((response) => {
      if (!Array.isArray(response.result?.items)) throw new Error("Reviews returned an invalid queue.");
      setItems(feedbackItems(response.result.items)); setError(null);
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      reading.current = false;
      if (again.current) { again.current = false; read(); }
    });
  }, []);
  useEffect(() => {
    load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") load(); }, 30_000);
    const visible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [load]);
  return { items, error, load };
}
