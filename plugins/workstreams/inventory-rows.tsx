// The PR inventory's rows (plan amendment A13): a dense table at 1100px and
// wider, two-line rows below. Presentational only: data and callbacks come in
// as props, no SDK hook is called, and imports stay relative, so
// static-markup tests can render it. A disabled action stays focusable and
// says why, in its accessible name and its tooltip.
import { useState, type ReactNode } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Icon } from "./components/ui/icon";
import { Tip } from "./components/ui/tooltip";
import { usePortalScopeProps } from "./lib/portal-scope";
import { cn, POINTER_CURSORS } from "./lib/utils";
import { parseLogins, type InventoryGroup, type InventoryLine, type LineAction } from "./inventory-view-model";

export type RowCallbacks = {
  /** Run a row action; a disabled one only explains itself. */
  onAction(line: InventoryLine, action: LineAction): void;
  /** Ask these reviewers, from the row's picker. */
  onRequest(line: InventoryLine, logins: string[]): void;
  /** Open a row's reviewer picker by PR URL, or close it. */
  onPicker(prUrl: string | null): void;
  onOpenPr(url: string): void;
  onOpenThread(id: string): void;
  onOpenRoster(effortId: string, n: number | null): void;
  /** Hold the PR, which asks for a reason first, or release its hold. */
  onHold(line: InventoryLine): void;
};
export type InventoryRowsProps = RowCallbacks & { groups: InventoryGroup[]; picker: string | null };

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-ring";
const REVIEW_WORD: Record<InventoryLine["reviewers"][number]["state"], string> = { requested: "asked", approved: "approved",
  "changes requested": "changes requested", commented: "commented", dismissed: "dismissed", reviewed: "reviewed" };

function Pr({ line, onOpenPr }: { line: InventoryLine } & Pick<RowCallbacks, "onOpenPr">) {
  return <button type="button" onClick={() => onOpenPr(line.prUrl)} title={`Open ${line.slug} #${line.number} on GitHub`}
    className={cn("min-w-0 truncate rounded-sm text-left hover:underline", FOCUS)}>
    {line.branch ? <span aria-hidden className="text-muted-foreground" style={{ paddingLeft: `${(line.depth - 1) * 12}px` }}>{line.branch} </span> : null}
    <span className="text-muted-foreground">{line.repo}</span> <span className="tabular-nums">#{line.number}</span>
  </button>;
}

function Title({ line, onOpenRoster }: { line: InventoryLine } & Pick<RowCallbacks, "onOpenRoster">) {
  const managed = line.managed;
  return <span className="flex min-w-0 items-center gap-1.5">
    {line.hold ? <Tip label={`Held by you ${line.hold.age} ago${line.hold.reason ? `: ${line.hold.reason}` : ""}. Nothing acts on it until you release it.`}>
      <span tabIndex={0} className={cn("inline-flex shrink-0 rounded-sm text-muted-foreground", FOCUS)}><Icon name="Pin" className="size-3.5" aria-label="Held" /></span>
    </Tip> : null}
    <span className="min-w-0 truncate" title={line.title}>{line.title || "—"}</span>
    {line.draft ? <span className="shrink-0 text-[11px] text-muted-foreground">draft</span> : null}
    {managed ? <button type="button" onClick={() => onOpenRoster(managed.effortId, managed.n)} title={`Open the ${managed.label}`}
      className={cn("shrink-0 rounded-full border border-border px-1.5 text-[11px] leading-4 text-muted-foreground hover:text-foreground", FOCUS)}>
      {managed.n === null ? "roster" : `roster #${managed.n}`}</button> : null}
  </span>;
}

function Reviewers({ line }: { line: InventoryLine }) {
  if (line.reviewers.length === 0) return <span className="text-muted-foreground">no reviewer</span>;
  const text = line.reviewers.map((reviewer) => `@${reviewer.login} ${REVIEW_WORD[reviewer.state]}`).join(", ");
  return <span className="block truncate" title={text}>{line.reviewers.map((reviewer, index) => <span key={reviewer.login}>
    {index ? ", " : ""}@{reviewer.login} <span className="text-muted-foreground">{REVIEW_WORD[reviewer.state]}</span>
  </span>)}</span>;
}

function Status({ line }: { line: InventoryLine }) {
  return <span className="flex min-w-0 items-center gap-1.5">
    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
    <span className="truncate" title={line.status}>{line.status}</span>
  </span>;
}

/**
 * The next steps, one per line up to `lines`, each with who owns it and how long it has waited, then how many more past the last line
 * shown, outside its truncation so it always shows; what a held or teammate's row says instead.
 */
function Next({ line, lines }: { line: InventoryLine; lines: 1 | 2 }) {
  if (line.steps.length === 0) {
    const text = line.hold ? `Held by you${line.hold.reason ? `: "${line.hold.reason}"` : ""}` : line.effortPile === "held" ? "Its effort is on hold"
      : line.authored ? "—" : "Asks nothing of you";
    return <span className={cn(lines === 1 ? "line-clamp-1" : "line-clamp-2", "text-muted-foreground")} title={text}>{text}</span>;
  }
  const full = line.steps.map((step) => [step.text, step.owner.label, step.age].filter(Boolean).join(" · ")).join("; ");
  const shown = line.steps.slice(0, lines);
  const more = line.steps.length - shown.length;
  return <span className="grid min-w-0" title={full}>{shown.map((step, index) => <span key={step.text} className="flex min-w-0">
    <span className="min-w-0 truncate">
      {step.text}
      <span className={step.owner.kind === "you" ? "text-foreground" : "text-muted-foreground"}> · {step.owner.label}</span>
      {step.age ? <span className="text-muted-foreground tabular-nums" title={step.ageTitle ?? undefined}> · {step.age}</span> : null}
    </span>
    {more > 0 && index === shown.length - 1 ? <span className="shrink-0 whitespace-pre text-muted-foreground"> · +{more}</span> : null}
  </span>)}</span>;
}

function Checked({ line }: { line: InventoryLine }) {
  return <span title={line.checked.title} className={cn("inline-flex items-center gap-1 whitespace-nowrap tabular-nums", line.checked.failed ? "text-destructive" : "text-muted-foreground")}>
    {line.checked.stale ? <span aria-label="Stale" data-tone="stale" className="size-1.5 shrink-0 rounded-full bg-amber-500" /> : null}
    {line.checked.text}
  </span>;
}

function Last({ line }: { line: InventoryLine }) {
  if (!line.last) return null;
  return <p role="status" className={cn("mt-0.5 line-clamp-2 text-[11px]", line.last.ok ? "text-muted-foreground" : "text-destructive")} title={line.last.text}>{line.last.text}</p>;
}

/** Its visible label first, so a voice command naming the button finds it, then its PR; what it does is its tooltip. */
const actionLabel = (line: InventoryLine, action: LineAction) =>
  `${action.label} ${line.repo} #${line.number}${action.enabled ? "" : `: unavailable, ${action.why}`}`;

/** One action control: text for a write, an icon for Refresh and Open thread. A disabled one stays focusable to say why. */
function ActionButton({ line, action, onAction, icon, children, popup }: { line: InventoryLine; action: LineAction; icon?: string; children?: ReactNode;
  popup?: boolean } & Pick<RowCallbacks, "onAction">) {
  const label = actionLabel(line, action);
  return <Tip label={action.enabled ? action.title : action.why ?? action.title}>
    <button type="button" data-inventory-action={action.id} aria-label={label} aria-disabled={action.enabled ? undefined : true}
      aria-haspopup={popup ? "dialog" : undefined} onClick={() => onAction(line, action)}
      className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[11px] leading-none", FOCUS,
        icon ? "w-6 justify-center border-transparent px-0 text-muted-foreground" : "border-border",
        action.enabled ? "hover:bg-foreground/[0.06] hover:text-foreground" : "cursor-not-allowed text-muted-foreground opacity-60",
        line.primary === action.id && action.enabled && !icon && "border-foreground/40 font-medium")}>
      {icon ? <Icon name={icon} className={cn("size-3.5", action.label === "Reading…" && "motion-safe:animate-spin")} aria-hidden /> : null}
      {children ?? (icon ? null : action.label)}
    </button>
  </Tip>;
}

/** The picker behind Request review…: this PR's suggested reviewers to toggle, a login field, and one button that asks them. */
export function ReviewerPickerBody({ line, onRequest, onCancel }: { line: InventoryLine; onRequest(logins: string[]): void; onCancel(): void }) {
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [text, setText] = useState("");
  const typed = parseLogins(text);
  const logins = [...new Set([...picked, ...typed.logins])];
  const toggle = (login: string) => setPicked((current) => current.includes(login) ? current.filter((item) => item !== login) : [...current, login]);
  const add = () => { setPicked((current) => [...new Set([...current, ...typed.logins])]); setText(""); };
  const shown = [...new Set([...line.suggested, ...picked])];
  return <div className="grid gap-2 text-[12px]">
    <p className="font-medium">Request review · {line.repo} #{line.number}</p>
    {shown.length ? <div role="group" aria-label="Suggested reviewers" className="flex flex-wrap gap-1">
      {shown.map((login) => <button key={login} type="button" aria-pressed={picked.includes(login)} onClick={() => toggle(login)}
        className={cn("rounded-full border px-2 py-0.5 text-[11px]", FOCUS, picked.includes(login) ? "border-foreground/50 bg-foreground/[0.1]" : "border-border text-muted-foreground hover:text-foreground")}>
        @{login}</button>)}
    </div> : <p className="text-[11px] text-muted-foreground">No past reviewers to suggest; type a login.</p>}
    <label className="grid gap-1 text-[11px] text-muted-foreground">GitHub login
      {/* Enter adds what you typed; only the button below sends. */}
      <input value={text} onChange={(event) => setText(event.target.value)} placeholder="login, or org/team" autoComplete="off" spellCheck={false}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }}
        className="h-7 rounded-md border border-input bg-background px-2 font-mono text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" />
    </label>
    {typed.invalid.length ? <p className="text-[11px] text-destructive">Not a GitHub login: {typed.invalid.join(", ")}</p> : null}
    <div className="flex items-center gap-2">
      <button type="button" data-inventory-request aria-disabled={logins.length ? undefined : true} onClick={() => { if (logins.length) onRequest(logins); }}
        title={logins.length ? "One request to GitHub, checked against the reviewers this row showed" : "Pick or type a reviewer first"}
        className={cn("inline-flex h-7 items-center rounded-md bg-foreground px-2.5 text-[12px] font-medium text-background", FOCUS,
          logins.length ? "hover:bg-foreground/90" : "cursor-not-allowed opacity-50")}>
        {logins.length ? `Request review from ${logins.map((login) => `@${login}`).join(", ")}` : "Request review"}</button>
      <button type="button" onClick={onCancel} className={cn("h-7 rounded-md px-2 text-[12px] hover:bg-foreground/[0.05]", FOCUS)}>Cancel</button>
    </div>
  </div>;
}

function Actions({ line, props }: { line: InventoryLine; props: InventoryRowsProps }) {
  const portalScope = usePortalScopeProps();
  const thread = line.actions.find((action) => action.id === "thread")!;
  const started = line.threads.find((item) => item.role === "started" && item.id !== thread.threadId);
  return <span className="flex flex-wrap items-center justify-end gap-1">
    {line.effortPile === "held" ? <Tip label="Its effort is on hold: nothing writes to this PR until you resume the effort">
      <span tabIndex={0} data-inventory-effort-hold className={cn("inline-flex h-6 items-center rounded-md bg-foreground/[0.05] px-1.5 text-[11px] text-muted-foreground", FOCUS)}>
        On hold</span></Tip> : null}
    {line.actions.map((action) => {
      if (action.id === "refresh") return <ActionButton key={action.id} line={line} action={action} icon={action.label === "Reading…" ? "Loading" : "ArrowReloadHorizontal"} onAction={props.onAction} />;
      if (action.id === "thread") return <ActionButton key={action.id} line={line} action={action} icon="MessageSquare" onAction={props.onAction} />;
      if (action.id !== "request-review" || !action.enabled) {
        return <ActionButton key={action.id} line={line} action={action} popup={action.id === "merge" || action.id === "request-review"} onAction={props.onAction} />;
      }
      return <PopoverPrimitive.Root key={action.id} open={props.picker === line.prUrl} onOpenChange={(open) => props.onPicker(open ? line.prUrl : null)}>
        <PopoverPrimitive.Trigger asChild>
          <button type="button" data-inventory-action={action.id} aria-label={actionLabel(line, action)} aria-haspopup="dialog" title={action.title}
            className={cn("inline-flex h-6 shrink-0 items-center rounded-md border border-border px-1.5 text-[11px] leading-none hover:bg-foreground/[0.06]", FOCUS,
              line.primary === action.id && "border-foreground/40 font-medium")}>{action.label}</button>
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content {...portalScope} role="dialog" aria-label={`Request review for ${line.repo} #${line.number}`} side="bottom" align="end" sideOffset={4}
            collisionPadding={8} className={cn("z-50 w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md outline-none", POINTER_CURSORS)}>
            <ReviewerPickerBody line={line} onRequest={(logins) => props.onRequest(line, logins)} onCancel={() => props.onPicker(null)} />
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>;
    })}
    <Tip label={line.hold ? "Release the hold: batches and actions may write to it again" : "Hold this PR: nothing acts on it until you release it"}>
      <button type="button" data-inventory-action="hold" aria-label={`${line.hold ? "Release" : "Hold…"} ${line.repo} #${line.number}`} onClick={() => props.onHold(line)}
        className={cn("inline-flex h-6 items-center rounded-md px-1 text-[11px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground", FOCUS)}>
        {line.hold ? "Release" : "Hold…"}</button>
    </Tip>
    {started ? <Tip label={`Open "${started.title}", where the work started`}>
      <button type="button" aria-label={`Open "${started.title}", where the work on ${line.repo} #${line.number} started`} onClick={() => props.onOpenThread(started.id)}
        className={cn("inline-flex h-6 items-center rounded-md px-1 text-[11px] text-muted-foreground hover:text-foreground", FOCUS)}>started</button>
    </Tip> : null}
  </span>;
}

function GroupHeader({ group, onOpenRoster }: { group: InventoryGroup } & Pick<RowCallbacks, "onOpenRoster">) {
  const count = <span className="font-normal tabular-nums text-muted-foreground"> · {group.lines.length}</span>;
  const effort = group.effort;
  if (!effort) return <span className="text-[12px] font-medium">{group.label}{count}</span>;
  return <button type="button" onClick={() => onOpenRoster(effort.id, null)} aria-label={`Open the ${effort.name} roster`} title={`Open the ${effort.name} roster`}
    className={cn("inline-flex min-w-0 items-center gap-1 rounded-sm text-[12px] font-medium hover:underline", FOCUS)}>
    <span className="truncate">{group.label}</span>{count}<Icon name="ChevronRight" className="size-3 shrink-0 text-muted-foreground" aria-hidden />
  </button>;
}

/** Rows take focus for the shared keys (j and k move between them), with the same inset ring as the deck's. */
const rowAttrs = (line: InventoryLine) => ({ "data-inventory-row": `${line.slug}#${line.number}`, "data-depth": line.depth, tabIndex: -1 });
const ROW_RING = "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500";

/** The narrowest pane the dense table fits: its fixed columns take 690px, and Title and Next · owner · age share the rest. */
export const TABLE_MIN_WIDTH = 1100;

/** The dense table, in a pane TABLE_MIN_WIDTH or wider: PR, title, reviewers, state, next step with owner and age, when GitHub last answered, and actions. */
export function InventoryTable(props: InventoryRowsProps) {
  return <table className="w-full table-fixed border-collapse text-[12px]">
    <colgroup>
      {/* Next · owner · age takes a share of the width, so a step keeps its owner and age in view; Title takes the rest. */}
      <col style={{ width: 112 }} /><col /><col style={{ width: 144 }} /><col style={{ width: 140 }} /><col style={{ width: "23%" }} /><col style={{ width: 118 }} />
      <col style={{ width: 176 }} />
    </colgroup>
    <thead>
      <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
        {["PR", "Title", "Reviewers", "Status", "Next · owner · age", "Checked"].map((label) => <th key={label} className="px-2 py-1.5 font-normal">{label}</th>)}
        <th className="px-2 py-1.5 font-normal"><span className="sr-only">Actions</span></th>
      </tr>
    </thead>
    {props.groups.map((group) => <tbody key={group.key} data-inventory-group={group.label}>
      <tr><th colSpan={7} className="border-b border-border/60 px-2 pb-1 pt-4 text-left font-normal"><GroupHeader group={group} onOpenRoster={props.onOpenRoster} /></th></tr>
      {group.lines.map((line) => <tr key={line.prUrl} {...rowAttrs(line)} className={cn("border-b border-border/50 align-top hover:bg-foreground/[0.03]", ROW_RING)}>
        <td className="px-2 py-1.5"><Pr line={line} onOpenPr={props.onOpenPr} /></td>
        <td className="px-2 py-1.5"><Title line={line} onOpenRoster={props.onOpenRoster} /></td>
        <td className="px-2 py-1.5"><Reviewers line={line} /></td>
        <td className="px-2 py-1.5"><Status line={line} /></td>
        <td className="px-2 py-1.5"><Next line={line} lines={2} /><Last line={line} /></td>
        <td className="px-2 py-1.5 text-[11px]"><Checked line={line} /></td>
        <td className="px-2 py-1"><Actions line={line} props={props} /></td>
      </tr>)}
    </tbody>)}
  </table>;
}

/** Two-line rows for a narrow pane: the PR, title, reviewers, and read age, then its state, next step, and actions. */
export function InventoryList(props: InventoryRowsProps) {
  return <div role="list" aria-label="Open PRs" className="text-[12px]">
    {props.groups.map((group) => <div key={group.key} role="presentation" data-inventory-group={group.label}>
      <div role="presentation" className="border-b border-border/60 px-3 pb-1 pt-4"><GroupHeader group={group} onOpenRoster={props.onOpenRoster} /></div>
      {group.lines.map((line) => <div key={line.prUrl} role="listitem" {...rowAttrs(line)} className={cn("border-b border-border/50 px-3 py-1.5 hover:bg-foreground/[0.03]", ROW_RING)}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0"><Pr line={line} onOpenPr={props.onOpenPr} /></span>
          <span className="min-w-0 flex-1"><Title line={line} onOpenRoster={props.onOpenRoster} /></span>
          <span className="max-w-32 shrink-0 truncate text-[11px]"><Reviewers line={line} /></span>
          <span className="shrink-0 text-[11px]"><Checked line={line} /></span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2" style={{ paddingLeft: line.depth ? `${line.depth * 12}px` : undefined }}>
          <span className="max-w-32 shrink-0 text-muted-foreground"><Status line={line} /></span>
          <span className="min-w-0 flex-1"><Next line={line} lines={1} /></span>
          <Actions line={line} props={props} />
        </div>
        <Last line={line} />
      </div>)}
    </div>)}
  </div>;
}
