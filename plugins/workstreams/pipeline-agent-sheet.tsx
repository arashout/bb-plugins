import { useEffect, useRef, useState } from "react";
import { UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Row } from "./inbox";
import type { AgentAction, ThreadMode } from "./actions";
import { AGENT_LABEL, actionPrompt } from "./actions";
import type { AdvancePreview, AdvanceRepairPlan } from "./bulk-advance";
import { advanceScope, advancePreviewSummary } from "./bulk-advance-preview";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export type PipelineAgentRequest =
  | { kind: "agent"; action: AgentAction; row: Row }
  | { kind: "advance"; prUrls: string[] }
  | { kind: "repair"; batchId: string; jobId: string };

type AgentPlan = Extract<
  Awaited<ReturnType<ReturnType<typeof useRpc<typeof rpcContract>>["call"]>>,
  { recommendation: unknown; capabilities: unknown }
>;
type Plan =
  | { kind: "agent"; value: AgentPlan }
  | { kind: "advance"; value: AdvancePreview }
  | { kind: "repair"; value: AdvanceRepairPlan };

const MODE_LABEL: Record<ThreadMode, string> = {
  continue: "Continue worker",
  subthread: "Linked subthread",
  new: "New thread",
};
const failure = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
const writes = (job: AdvancePreview["jobs"][number]) =>
  job.eligible && (job.needsFeedback || job.needsPreparation);
const readOnly = (plan: AdvancePreview) =>
  plan.jobs.some((job) => job.eligible) && !plan.jobs.some(writes);

function shortPlan(
  feedback: boolean,
  preparation: boolean,
  eligible = true,
): string {
  if (!eligible) return "Skip this PR";
  if (feedback && preparation) return "Fix, prepare, verify";
  if (feedback) return "Fix and verify";
  if (preparation) return "Prepare and verify";
  return "Verify merge readiness";
}

export function PipelineAgentSheet({
  request,
  onClose,
  onStarted,
  onOpenThread,
}: {
  request: PipelineAgentRequest | null;
  onClose: () => void;
  onStarted?: () => void;
  onOpenThread?: (threadId: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [mode, setMode] = useState<ThreadMode>("new");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  const generation = useRef(0);
  const launch = useRef(false);
  const requestKey =
    request === null
      ? null
      : request.kind === "agent"
        ? JSON.stringify([request.kind, request.action, request.row.unit.path])
        : request.kind === "advance"
          ? JSON.stringify([request.kind, request.prUrls])
          : JSON.stringify([request.kind, request.batchId, request.jobId]);

  useEffect(() => {
    const sequence = ++generation.current;
    setPlan(null);
    setError(null);
    setNotice(null);
    setStarted(null);
    setBusy(false);
    setMode("new");
    setThreadId(null);
    setInstruction("");
    launch.current = false;
    if (request === null) return;
    const load = async () => {
      try {
        let next: Plan;
        if (request.kind === "agent") {
          const value = await rpc.call("agent_plan", {
            path: request.row.unit.path,
            action: request.action,
          });
          if (!value.ok) throw new Error(value.error);
          next = { kind: "agent", value };
        } else if (request.kind === "advance") {
          next = {
            kind: "advance",
            value: await rpc.call("advance_preview", {
              prUrls: request.prUrls,
            }),
          };
        } else {
          next = {
            kind: "repair",
            value: await rpc.call("advance_repair_plan", {
              batchId: request.batchId,
              jobId: request.jobId,
            }),
          };
        }
        if (generation.current !== sequence) return;
        setPlan(next);
        if (next.kind === "agent" || next.kind === "repair") {
          setMode(next.value.recommendation.mode);
          setThreadId(next.value.recommendation.threadId);
          if (next.kind === "agent" && request.kind === "agent")
            setInstruction(
              actionPrompt(request.action, {
                repo: request.row.repo,
                prNumber: request.row.unit.pr?.number ?? null,
                title: request.row.unit.pr ? request.row.title : null,
                branch: request.row.unit.branch,
                path: request.row.unit.path,
              }),
            );
        }
        if (next.kind === "advance" && readOnly(next.value)) {
          launch.current = true;
          const fresh =
            next.value.expiresAt > Date.now()
              ? next.value
              : await rpc.call("advance_preview", {
                  prUrls: request.kind === "advance" ? request.prUrls : [],
                });
          if (generation.current !== sequence) return;
          setPlan({ kind: "advance", value: fresh });
          if (!readOnly(fresh)) {
            launch.current = false;
            setNotice(
              "The plan changed and may push code. Review it before starting.",
            );
            return;
          }
          await rpc.call("advance_start", { token: fresh.token });
          if (generation.current !== sequence) return;
          toast.success("Readiness check started");
          onStarted?.();
          onClose();
        }
      } catch (cause) {
        if (generation.current === sequence) setError(failure(cause));
      } finally {
        if (generation.current === sequence) launch.current = false;
      }
    };
    void load();
    return () => {
      generation.current++;
    };
  }, [requestKey]);

  const active = plan?.kind === request?.kind ? plan : null;
  const selected =
    active?.kind === "agent" || active?.kind === "repair" ? active.value : null;
  const candidates = selected?.candidates ?? [];
  const availableModes: ThreadMode[] =
    active?.kind === "repair"
      ? active.value.modes
      : active?.kind === "agent"
        ? [
            "new",
            ...(active.value.capabilities.subthread &&
            candidates.some((candidate) => candidate.canSpawnChild)
              ? ["subthread" as const]
              : []),
          ]
        : [];
  const eligibleCandidates = candidates.filter((candidate) =>
    mode === "continue"
      ? "canContinue" in candidate && candidate.canContinue
      : candidate.canSpawnChild,
  );
  const canStart =
    active !== null &&
    (active.kind === "advance"
      ? active.value.jobs.some((job) => job.eligible)
      : availableModes.includes(mode) &&
        (mode === "new" ||
          eligibleCandidates.some((candidate) => candidate.id === threadId)) &&
        (active.kind === "repair" || instruction.trim() !== ""));

  const start = async () => {
    if (!request || !active || !canStart || busy || launch.current) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (active.kind === "advance" && request.kind === "advance") {
        let fresh = active.value;
        if (fresh.expiresAt <= Date.now()) {
          fresh = await rpc.call("advance_preview", { prUrls: request.prUrls });
          setPlan({ kind: "advance", value: fresh });
          if (advanceScope(fresh) !== advanceScope(active.value)) {
            setNotice(
              "The plan changed. Review the updated PR work before starting.",
            );
            return;
          }
          if (!fresh.jobs.some((job) => job.eligible)) {
            setNotice("No PRs are eligible in the updated plan.");
            return;
          }
        }
        await rpc.call("advance_start", { token: fresh.token });
        toast.success("Advance started");
        onStarted?.();
        onClose();
      } else if (active.kind === "agent" && request.kind === "agent") {
        const result = await rpc.call("agent_run", {
          path: request.row.unit.path,
          action: request.action,
          mode,
          threadId: mode === "new" ? null : threadId,
          prompt: instruction,
        });
        if (!result.ok) throw new Error(result.error);
        onStarted?.();
        onClose();
        navigate.toThread(result.threadId);
      } else if (active.kind === "repair" && request.kind === "repair") {
        let fresh = active.value;
        if (fresh.expiresAt <= Date.now()) {
          fresh = await rpc.call("advance_repair_plan", {
            batchId: request.batchId,
            jobId: request.jobId,
          });
          setPlan({ kind: "repair", value: fresh });
          const routeChanged =
            !fresh.modes.includes(mode) ||
            (mode !== "new" &&
              !fresh.candidates.some(
                (candidate) =>
                  candidate.id === threadId &&
                  (mode === "continue"
                    ? candidate.canContinue
                    : candidate.canSpawnChild),
              ));
          if (routeChanged) {
            setMode(fresh.recommendation.mode);
            setThreadId(fresh.recommendation.threadId);
          }
          setNotice("The repair preview expired. Review the refreshed plan before starting.");
          return;
        }
        const result = await rpc.call("advance_repair_run", {
          token: fresh.token,
          mode,
          threadId: mode === "new" ? null : threadId,
          instruction: instruction.trim(),
        });
        setStarted(result.threadId);
        onStarted?.();
      }
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  };

  const title =
    request?.kind === "agent"
      ? AGENT_LABEL[request.action]
      : request?.kind === "repair"
        ? "Fix this PR"
        : "Advance approved PRs";
  const description =
    request?.kind === "agent"
      ? "An agent handles the selected action and reports the result. It does not merge the PR."
      : request?.kind === "repair"
        ? "An agent repairs the remaining blocker and checks readiness. It does not merge the PR."
        : "Agents prepare branches and address feedback where needed, then check readiness. They do not merge PRs.";
  const rows =
    active?.kind === "advance"
      ? active.value.jobs.map((job) => ({
          key: job.prUrl,
          url: job.prUrl,
          label: `${job.repo} #${job.number}`,
          title: job.title,
          plan: shortPlan(
            job.needsFeedback,
            job.needsPreparation,
            job.eligible,
          ),
          workspace:
            job.workspace === "existing"
              ? "Matched checkout"
              : job.workspace === "create"
                ? "New checkout"
                : "Unavailable",
          pushes: writes(job),
          detail: job.detail,
          eligible: job.eligible,
        }))
      : active?.kind === "repair"
        ? [
            {
              key: active.value.job.id,
              url: active.value.job.prUrl,
              label: `${active.value.job.repo} #${active.value.job.number}`,
              title: active.value.job.title,
              plan: "Repair and verify",
              workspace:
                mode === "continue"
                  ? "Previous checkout"
                  : active.value.fresh.workspace === "create"
                    ? "New checkout"
                    : "Matched checkout",
              pushes: true,
              detail: active.value.job.detail,
              eligible: true,
            },
          ]
        : request?.kind === "agent"
          ? [
              {
                key: request.row.key,
                url: request.row.unit.pr?.url,
                label: `${request.row.repo}${request.row.unit.pr ? ` #${request.row.unit.pr.number}` : ""}`,
                title: request.row.title,
                plan:
                  request.action === "investigate-ci"
                    ? "Investigate CI failure"
                    : request.action === "resolve-conflicts"
                      ? "Resolve merge conflicts"
                      : "Address review feedback",
                workspace: request.row.unit.path,
                pushes: request.action !== "investigate-ci",
                detail: request.row.title,
                eligible: true,
              },
            ]
          : [];
  const advanceSummary =
    active?.kind === "advance"
      ? advancePreviewSummary(active.value.jobs)
      : null;

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !busy && !launch.current) onClose();
      }}
    >
      <DialogContent className="max-h-[min(85vh,900px)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{started ? "Repair started" : title}</DialogTitle>
          <DialogDescription>
            {started ? "The worker is tracked on this PR." : description}
          </DialogDescription>
        </DialogHeader>
        {started ? (
          <div className="flex items-center gap-3 text-xs">
            <Button
              variant="outline"
              onClick={() => onOpenThread?.(started)}
              disabled={!onOpenThread}
            >
              Open thread
            </Button>
          </div>
        ) : (
          <>
            {!active && !error ? (
              <p role="status" className="text-xs text-muted-foreground">
                Reading the current plan…
              </p>
            ) : null}
            {rows.length > 0 ? (
              <div className="overflow-x-auto rounded-md border border-border text-xs">
                <table className="w-full text-left">
                  <thead className="bg-foreground/[0.04] text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-3 py-2">
                        PR
                      </th>
                      <th scope="col" className="px-3 py-2">
                        Plan
                      </th>
                      <th scope="col" className="px-3 py-2">
                        Workspace
                      </th>
                      <th scope="col" className="px-3 py-2">
                        Effect
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {rows.map((row) => (
                      <tr key={row.key} className="align-top">
                        <td className="max-w-44 px-3 py-2 font-medium">
                          {row.url ? (
                            <UrlLink
                              href={row.url}
                              className="break-words underline-offset-2 hover:underline"
                            >
                              {row.label}
                            </UrlLink>
                          ) : (
                            row.label
                          )}
                          <span className="mt-0.5 block break-words font-normal text-muted-foreground">
                            {row.title}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          {row.plan}
                          {!row.eligible ? (
                            <span className="mt-1 block break-words text-amber-800 dark:text-amber-300">
                              {row.detail}
                            </span>
                          ) : null}
                        </td>
                        <td
                          className="max-w-40 break-words px-3 py-2 text-muted-foreground"
                          title={row.workspace}
                        >
                          {row.workspace}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={cn(
                              "rounded px-1.5 py-0.5 font-medium",
                              row.pushes
                                ? "bg-amber-500/10 text-amber-800 dark:text-amber-300"
                                : "bg-foreground/[0.06] text-muted-foreground",
                            )}
                          >
                            {row.pushes ? "Pushes" : "Read-only"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {active?.kind === "advance" &&
            active.value.jobs.some((job) => !job.eligible) ? (
              <p className="text-xs text-muted-foreground">
                Ineligible PRs are skipped.
              </p>
            ) : null}
            {selected ? (
              <section aria-label="Where to run" className="space-y-2 text-xs">
                <h3 className="font-medium">Where to run</h3>
                <p className="text-muted-foreground">
                  {selected.recommendation.reason}
                </p>
                <div
                  role="radiogroup"
                  aria-label="Where to run"
                  className="flex flex-wrap gap-1.5"
                >
                  {availableModes.map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={mode === option}
                      disabled={busy}
                      onClick={() => {
                        setMode(option);
                        if (option !== "new") {
                          const choices = candidates.filter((candidate) =>
                            option === "continue"
                              ? "canContinue" in candidate &&
                                candidate.canContinue
                              : candidate.canSpawnChild,
                          );
                          if (
                            !choices.some(
                              (candidate) => candidate.id === threadId,
                            )
                          )
                            setThreadId(choices[0]?.id ?? null);
                        }
                      }}
                      className={cn(
                        "rounded-md border px-2.5 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
                        mode === option
                          ? "border-foreground/60 bg-foreground/[0.07] font-medium"
                          : "border-border",
                      )}
                    >
                      {MODE_LABEL[option]}
                      {selected.recommendation.mode === option
                        ? " · recommended"
                        : ""}
                    </button>
                  ))}
                </div>
                {mode !== "new" ? (
                  <label className="grid gap-1">
                    {mode === "continue" ? "Worker" : "Parent thread"}
                    <select
                      value={threadId ?? ""}
                      disabled={busy}
                      onChange={(event) => setThreadId(event.target.value)}
                      className="h-8 w-full rounded-md border border-input bg-background px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="" disabled>
                        Choose a thread
                      </option>
                      {eligibleCandidates.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.title} ·{" "}
                          {candidate.running ? "running" : "idle"}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </section>
            ) : active?.kind === "advance" && active.value.jobs.some(writes) ? (
              <p className="text-xs text-muted-foreground">
                Work runs in separate checkout workers, one per repository.
              </p>
            ) : null}
            {active?.kind === "advance" && advanceSummary ? (
              <details className="rounded-md border border-border px-3 py-2 text-xs">
                <summary className="cursor-pointer font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Instructions · fixed for this batch
                </summary>
                <div className="mt-2 space-y-1 text-muted-foreground">
                  {advanceSummary.hasFeedback ? (
                    <p>
                      Read review feedback, address remaining changes, test, and
                      reply with evidence.
                    </p>
                  ) : null}
                  {advanceSummary.hasPreparation ? (
                    <p>
                      Integrate the current base branch, resolve conflicts,
                      test, and push changes.
                    </p>
                  ) : null}
                  <p>
                    Check approval, unresolved feedback, checks, and
                    mergeability against the final commit. Do not merge.
                  </p>
                  <p>
                    These batch instructions are fixed by the advance service.
                  </p>
                </div>
              </details>
            ) : null}
            {active?.kind === "agent" || active?.kind === "repair" ? (
              <details className="rounded-md border border-border px-3 py-2 text-xs">
                <summary className="cursor-pointer font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Instructions
                </summary>
                <label className="mt-2 grid gap-1">
                  {active.kind === "agent"
                    ? "Agent prompt"
                    : "Additional direction"}
                  <textarea
                    value={instruction}
                    onChange={(event) => setInstruction(event.target.value)}
                    maxLength={active.kind === "agent" ? 8_000 : 4_000}
                    rows={6}
                    disabled={busy}
                    className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
              </details>
            ) : null}
            {active?.kind === "repair" ? (
              <p className="text-xs text-muted-foreground">
                {active.value.fresh.detail}
              </p>
            ) : null}
            {notice ? (
              <p
                role="status"
                className="text-xs text-amber-800 dark:text-amber-300"
              >
                {notice}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </>
        )}
        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            disabled={busy || launch.current}
            onClick={onClose}
          >
            {started ? "Close" : "Cancel"}
          </Button>
          {!started ? (
            <Button
              disabled={!canStart || busy || launch.current}
              onClick={() => void start()}
            >
              {busy || launch.current ? "Starting…" : "Start"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
