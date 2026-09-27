import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Icon, type IconName } from "./components/ui/icon";
import { cn } from "./lib/utils";

type Indicator = PluginSidebarThread["indicator"];

const WORKING_ICONS: Partial<Record<Indicator, IconName>> = {
  workflow: "Workflow",
  "background-agent": "UserRoundPlus",
  "background-command": "Terminal",
  "plan-mode": "ListTodo",
  goal: "Target",
};

/** Prefer the card's current thread, then visible state on another known linked thread. */
export function resolvePipelineThreadIndicator(
  threadIds: readonly string[],
  sidebarThreads: readonly PluginSidebarThread[],
  preferredThreadId?: string | null,
): PluginSidebarThread | null {
  const linked = new Set(threadIds);
  if (preferredThreadId) linked.add(preferredThreadId);
  const visible = (id: string) => sidebarThreads.find((thread) => thread.id === id && thread.indicator !== "none") ?? null;
  if (preferredThreadId) {
    const preferred = visible(preferredThreadId);
    if (preferred) return preferred;
  }
  for (const id of linked) {
    const thread = visible(id);
    if (thread) return thread;
  }
  return null;
}

export function PipelineThreadIndicator({
  threadIds,
  sidebarThreads,
  preferredThreadId,
  className,
}: {
  threadIds: readonly string[];
  sidebarThreads: readonly PluginSidebarThread[];
  preferredThreadId?: string | null;
  className?: string;
}) {
  const thread = resolvePipelineThreadIndicator(threadIds, sidebarThreads, preferredThreadId);
  if (!thread) return null;
  const label = thread.indicatorLabel ?? undefined;
  const iconClass = cn("size-4 shrink-0", className);
  switch (thread.indicator) {
    case "unread-error":
      return <Icon name="CircleX" className={cn(iconClass, "text-destructive")} aria-label={label} />;
    case "waiting-for-input":
      return <Icon name="CircleQuestion" className={cn(iconClass, "text-muted-foreground/75")} aria-label={label} />;
    case "runtime":
      return <Icon name="Loading" className={cn(iconClass, "motion-safe:animate-spin text-muted-foreground/50")} aria-label={label} />;
    case "working-draft":
      return <Icon name="Edit" className={cn(iconClass, "animate-shine-icon text-muted-foreground/50")} aria-label={label} />;
    case "draft":
      return <Icon name="Edit" className={cn(iconClass, "text-muted-foreground")} aria-label={label} />;
    case "unread-success":
      return <span className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)} role="img" aria-label={label}><span className="size-[5px] rounded-full bg-muted-foreground/60" /></span>;
    case "workflow":
    case "background-agent":
    case "background-command":
    case "plan-mode":
    case "goal":
      return <Icon name={WORKING_ICONS[thread.indicator]!} className={cn(iconClass, "animate-shine-icon text-muted-foreground/50")} aria-label={label} />;
    case "none":
      return null;
  }
}
