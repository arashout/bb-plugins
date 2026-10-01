// Worker completion reports (plan §2.9). A v2 worker ends its turn with one
// `Workstreams result v1:` line; this reads it strictly, binds its evidence to
// the head it names, and turns it into the key its recipes route. A report
// never clears a row: feedback evidence counts only once it validates against
// fresh facts, and verification reads GitHub again.
//
// The compatibility adapter reads legacy Advance output the same way: its
// completion marker, its feedback evidence line, and the two field names older
// workers wrote (finalHeadOid, approvalFeedbackFingerprint), each only when the
// canonical field is absent and the value is the live fact it names. Every
// adaptation is recorded, and the raw output is kept whatever the result.
import { z } from "zod";
import type { AdvanceFacts } from "./advance-contract.js";
import { FEEDBACK_REPORT_PREFIX, feedbackFindingSchema, feedbackReportSchema, validateFeedbackReport, type FeedbackReport } from "./approval-feedback.js";
import type { Attempt } from "./effort-phase.js";
import { BLOCKER_KINDS, RESULT_PREFIX, type WORKER_RESULTS } from "./effort-recipes.js";
import type { CriterionEvidence } from "./outcome-evidence.js";
import { canonicalPrUrl } from "./pr-holds.js";

const SHA = /^[0-9a-f]{40}$/u;
const FINGERPRINT = /^[0-9a-f]{64}$/u;
const LINE_LIMIT = 50_000;
/** How much of a turn's output a report keeps: its tail, where the result line is. */
export const RAW_LIMIT = 64 * 1024;
const sha = z.string().regex(SHA);
/** An option a blocker offers, and what choosing it would mean for the work. */
const optionSchema = z.object({ id: z.string().min(1).max(100), label: z.string().min(1).max(500), consequence: z.string().max(500).nullable().default(null) }).strict();
/** The documented fields and nothing else; the arrays a worker had nothing to put in may be left out. */
export const envelopeSchema = z.object({
  attemptId: z.string().min(1).max(100),
  target: z.string().min(1).max(500),
  actions: z.array(z.enum(["integrate_base", "fix_failing_checks", "address_review_feedback", "validate_criteria", "repair_report"])).max(5),
  outcome: z.enum(["changed", "no-change", "blocked", "failed"]),
  headOid: sha,
  baseOid: sha,
  commits: z.array(sha).max(200).default([]),
  validation: z.array(z.object({ command: z.string().max(2_000), result: z.enum(["passed", "failed", "not-run"]), detail: z.string().max(4_000) }).strict()).max(100).default([]),
  feedback: z.object({ fingerprint: z.string().regex(FINGERPRINT), findings: z.array(feedbackFindingSchema).min(1).max(300) }).strict().optional(),
  criteria: z.array(z.object({ id: z.string().regex(/^(c\d+|ticket:[A-Za-z][A-Za-z0-9]*-\d+)$/u), outcome: z.enum(["passed", "failed", "not-run"]),
    evidence: z.string().max(4_000) }).strict()).max(100).default([]),
  blockers: z.array(z.object({ kind: z.enum(BLOCKER_KINDS), summary: z.string().min(1).max(1_000), question: z.string().max(1_000).nullable().default(null),
    options: z.array(optionSchema).max(10).default([]), recommendation: z.string().max(100).nullable().default(null),
    recommendationReason: z.string().max(1_000).nullable().default(null), prUrl: z.string().max(500).nullable().default(null),
    checks: z.array(z.string().max(300)).max(50).default([]), evidence: z.array(z.string().max(500)).max(20).default([]) }).strict()).max(20).default([]),
}).strict();
export type Envelope = z.infer<typeof envelopeSchema>;

/** What a finished turn reported, read against the attempt that asked for it and fresh facts. */
export type CompletionReport = {
  /** The output's last 64 KB, kept whatever the result. */
  raw: string;
  source: "v1" | "legacy" | null;
  envelope: Envelope | null;
  /** Each legacy form and older field name the adapter read, such as `finalHeadOid → headOid`. */
  compat: string[];
  /** Why the report can't be used; null once accepted. */
  rejection: string | null;
  /** What the recipes' `otherwise` routes: the first blocker as blocked:<kind>, else the outcome, or report-invalid. */
  key: (typeof WORKER_RESULTS)[number];
  /** The head the report names; its criteria evidence is bound to it. */
  headOid: string | null;
  /** Feedback evidence from a report that succeeded, validated against fresh facts, ready to save with worker provenance. */
  feedback: FeedbackReport | null;
  /** The attempt's instruction revision binds them when they are read as evidence. */
  criteria: Omit<CriterionEvidence, "revision">[];
  blocker: Attempt["blocker"];
  /** The base moved after the worker read it: verification reads again instead of rejecting the report. */
  baseMoved: boolean;
};
export type ExpectedReport = { attemptId: string; target: string; fresh: Pick<AdvanceFacts, "headOid" | "baseOid" | "approvalFeedback"> };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** An older worker's name for a field, read as that field only when the field itself is absent and the value is the live fact. */
function unalias(record: unknown, from: string, to: string, pattern: RegExp, live: string | null, compat: string[]): string | null {
  if (!isRecord(record) || !(from in record)) return null;
  if (to in record) return `The report has both ${from} and ${to}.`;
  const value = record[from];
  if (typeof value !== "string" || !pattern.test(value)) return `${from} isn't a valid ${to}.`;
  if (value !== live) return `${from} ${value.slice(0, 12)} isn't the live ${to}${live ? ` ${live.slice(0, 12)}` : ""}.`;
  record[to] = value;
  delete record[from];
  compat.push(`${from} → ${to}`);
  return null;
}
/** The one line with this prefix, as JSON, or why it can't be read. */
function onlyLine(output: string, prefix: string, name: string): { json: unknown } | { error: string } | null {
  const lines = output.split(/\r?\n/u).filter((line) => line.startsWith(prefix));
  if (lines.length === 0) return null;
  if (lines.length > 1) return { error: `The output has ${lines.length} ${name} lines; a report has exactly one.` };
  if (lines[0]!.length > LINE_LIMIT) return { error: `The ${name} line is over 50 KB.` };
  try { return { json: JSON.parse(lines[0]!.slice(prefix.length)) }; } catch { return { error: `The ${name} line isn't JSON.` }; }
}
const zodError = (error: z.ZodError) => error.issues.map((issue) => `${issue.path.join(".") || "report"}: ${issue.message}`).join("; ");

/** Read a finished turn's output: the v1 result line, else legacy Advance's marker and evidence line. */
export function parseCompletion(output: string, expected: ExpectedReport): CompletionReport {
  const { fresh } = expected;
  const compat: string[] = [];
  const empty = { raw: output.length > RAW_LIMIT ? output.slice(-RAW_LIMIT) : output, compat, envelope: null, headOid: null, feedback: null, criteria: [], blocker: null, baseMoved: false };
  const reject = (source: CompletionReport["source"], rejection: string): CompletionReport => ({ ...empty, source, rejection, key: "report-invalid" });
  const liveFingerprint = fresh.approvalFeedback.status === "present" ? fresh.approvalFeedback.fingerprint : null;

  const line = onlyLine(output, RESULT_PREFIX, "result");
  if (line === null) return legacy();
  if ("error" in line) return reject("v1", line.error);
  const aliased = unalias(line.json, "finalHeadOid", "headOid", SHA, fresh.headOid, compat)
    ?? unalias(isRecord(line.json) ? line.json.feedback : null, "approvalFeedbackFingerprint", "fingerprint", FINGERPRINT, liveFingerprint, compat);
  if (aliased) return reject("v1", aliased);
  const parsed = envelopeSchema.safeParse(line.json);
  if (!parsed.success) return reject("v1", zodError(parsed.error));
  const envelope = parsed.data;
  if (envelope.attemptId !== expected.attemptId) return reject("v1", `The report is for attempt ${envelope.attemptId}, not ${expected.attemptId}.`);
  const target = canonicalPrUrl(expected.target);
  if (canonicalPrUrl(envelope.target) !== target) return reject("v1", `The report is for ${envelope.target}, not ${expected.target}.`);
  const [first] = envelope.blockers;
  // A report that lists a blocker never reads as changed or no-change, whatever its outcome says.
  const key = first ? `blocked:${first.kind}` as const : envelope.outcome === "blocked" ? null : envelope.outcome;
  if (key === null) return reject("v1", "A blocked report names its blocker.");
  // Only a report that succeeded vouches for its feedback evidence, as legacy Advance saved it only from a prepared job.
  const feedback = envelope.feedback && (key === "changed" || key === "no-change") && validateFeedbackReport({ attemptId: envelope.attemptId, headOid: envelope.headOid, fingerprint: envelope.feedback.fingerprint,
    findings: envelope.feedback.findings, blockers: envelope.blockers.map((blocker) => blocker.summary.slice(0, 500)) }, expected.attemptId, fresh.approvalFeedback, fresh.headOid);
  return {
    ...empty, source: "v1", envelope, rejection: null, key, headOid: envelope.headOid, feedback: feedback || null,
    criteria: envelope.criteria.map((item) => ({ criterion: item.id, target: target ?? expected.target, headOid: envelope.headOid, outcome: item.outcome, accepted: true })),
    blocker: first ? { summary: first.summary, question: first.question, options: first.options.map(({ id, label }) => ({ id, label })), prUrl: first.prUrl } : null,
    baseMoved: fresh.baseOid !== "" && envelope.baseOid !== fresh.baseOid,
  };

  /** Legacy Advance: `Workstreams job <attempt> complete: prepared|blocked` on the last line, and at most one feedback evidence line. */
  function legacy(): CompletionReport {
    const marker = /^Workstreams job (\S+) complete: (prepared|blocked)$/u.exec(output.trim().split(/\r?\n/u).at(-1)?.trim() ?? "");
    if (!marker) return reject(null, "The output has no Workstreams result line.");
    if (marker[1] !== expected.attemptId) return reject("legacy", `The completion marker is for attempt ${marker[1]}, not ${expected.attemptId}.`);
    compat.push(`legacy completion marker: ${marker[2]}`);
    const evidence = onlyLine(output, FEEDBACK_REPORT_PREFIX, "feedback evidence");
    let report: FeedbackReport | null = null;
    if (evidence !== null) {
      if ("error" in evidence) return reject("legacy", evidence.error);
      compat.push("legacy feedback evidence line");
      const aliased = unalias(evidence.json, "finalHeadOid", "headOid", SHA, fresh.headOid, compat)
        ?? unalias(evidence.json, "approvalFeedbackFingerprint", "fingerprint", FINGERPRINT, liveFingerprint, compat);
      if (aliased) return reject("legacy", aliased);
      const parsed = feedbackReportSchema.safeParse(evidence.json);
      if (!parsed.success) return reject("legacy", zodError(parsed.error));
      report = parsed.data;
    }
    // The marker names no blocker kind, and prose is never parsed, so a legacy block is a system issue, never an invented decision.
    const blocked = marker[2] === "blocked";
    return { ...empty, source: "legacy", rejection: null, key: blocked ? "blocked:other" : "changed", headOid: report?.headOid ?? null,
      feedback: report && !blocked ? validateFeedbackReport(report, expected.attemptId, fresh.approvalFeedback, fresh.headOid) : null,
      blocker: blocked ? { summary: "The legacy worker reported blocked without naming a blocker", question: null, options: [], prUrl: null } : null };
  }
}
