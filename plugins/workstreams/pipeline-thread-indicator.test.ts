import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { PipelineThreadIndicator, resolvePipelineThreadIndicator } from "./pipeline-thread-indicator";

function thread(id: string, indicator: PluginSidebarThread["indicator"]): PluginSidebarThread {
  return { id, indicator, indicatorLabel: `Thread ${indicator}`, isUnread: indicator.startsWith("unread") } as PluginSidebarThread;
}

describe("PipelineThreadIndicator", () => {
  it("shows a linked unread thread even when the card has no current activity thread", () => {
    const live = [thread("worker", "unread-success")];
    expect(resolvePipelineThreadIndicator(["worker"], live, null)?.id).toBe("worker");
    const html = renderToStaticMarkup(createElement(PipelineThreadIndicator, { threadIds: ["worker"], sidebarThreads: live }));
    expect(html).toContain("Thread unread-success");
    expect(html).toContain("bg-muted-foreground/60");
  });

  it("uses the host's working indicator for the current thread before a linked unread result", () => {
    const live = [thread("older", "unread-success"), thread("current", "runtime")];
    live[1]!.isUnread = true; // The host indicator, not a separate unread flag, owns the glyph.
    const selected = resolvePipelineThreadIndicator(["older", "current"], live, "current");
    expect(selected?.indicator).toBe("runtime");
    const html = renderToStaticMarkup(createElement(PipelineThreadIndicator, { threadIds: ["older", "current"], sidebarThreads: live, preferredThreadId: "current" }));
    expect(html).toContain("motion-safe:animate-spin");
    expect(html).toContain("Thread runtime");
  });

  it("ignores idle and unknown threads rather than inferring unread from work completion", () => {
    expect(resolvePipelineThreadIndicator(["idle", "missing"], [thread("idle", "none")])).toBeNull();
    expect(renderToStaticMarkup(createElement(PipelineThreadIndicator, { threadIds: ["idle"], sidebarThreads: [thread("idle", "none")] }))).toBe("");
  });
});
