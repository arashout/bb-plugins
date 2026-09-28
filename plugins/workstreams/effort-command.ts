// Numbered effort commands. The command is the authorization boundary: code,
// not a model, turns "move 1-6 forward, leave 3 alone" into exact targets and
// per-target effects against the snapshot the user saw. Anything it can't read
// exactly is clarified with a copyable reading, and nothing is admitted. Work
// verbs add to the active instruction; only `only`/`instead` replace it and
// `drop` removes from it, and the acknowledgment names what each takes away.
// A hold is not an exclusion: `leave 3 alone` lasts one instruction, a hold
// outlasts every instruction, so every acknowledgment names held targets.
import { z } from "zod";
import { prTarget } from "./ghactions.js";
import { canonicalPrUrl, prHoldFor, type PrHolds } from "./pr-holds.js";
import { EFFECT_LABEL as SHARED_EFFECT_LABEL, formatTargets } from "./roster-shared.js";

export { formatTargets };

/** Everything an instruction can grant. Merge is not here: it has its own fresh preview and confirmation. */
export const EFFECTS = ["code-fix", "test", "push", "pr-reply", "resolve-addressed-threads", "retarget-base", "rerun-checks", "request-rereview", "mark-ready", "request-review"] as const;
export type Effect = (typeof EFFECTS)[number];
/** The worker recipes a work verb authorizes; the recipe catalog defines them. */
export const WORK_RECIPES = ["integrate_base", "fix_failing_checks", "address_review_feedback", "validate_criteria"] as const;
export type WorkRecipe = (typeof WORK_RECIPES)[number];
/** What `move forward` grants: never mark-ready, a new review request, or merge. */
export const DEFAULT_EFFECTS: Effect[] = ["code-fix", "test", "push", "pr-reply", "resolve-addressed-threads", "retarget-base", "rerun-checks", "request-rereview"];
/** `local only` keeps the effects that stay in the checkout. */
const LOCAL: Effect[] = ["code-fix", "test"];
export const VERBS = {
  "move forward": { work: [...WORK_RECIPES], effects: DEFAULT_EFFECTS },
  rebase: { work: ["integrate_base"], effects: ["code-fix", "test", "push", "retarget-base"] },
  "fix ci": { work: ["fix_failing_checks"], effects: ["code-fix", "test", "push", "rerun-checks"] },
  "address review": { work: ["address_review_feedback"], effects: ["code-fix", "test", "push", "pr-reply", "resolve-addressed-threads", "request-rereview"] },
} satisfies Record<string, { work: WorkRecipe[]; effects: Effect[] }>;
type Verb = keyof typeof VERBS;
type ReportMode = "changes" | "decisions-only" | "quiet";

const n = z.number().int().positive().nullable();
/** The instruction's scope after a command; admission stores it with the text and source that produced it. */
export const instructionScopeSchema = z.object({
  revision: z.number().int().nonnegative(),
  include: z.array(z.object({ target: z.string(), n, outsideMembership: z.boolean(), work: z.array(z.enum(WORK_RECIPES)),
    effects: z.array(z.enum(EFFECTS)), reviewers: z.array(z.string()), addedInRevision: z.number().int().positive() }).strict()),
  exclude: z.array(z.object({ target: z.string(), n, reason: z.string() }).strict()),
  removed: z.array(z.object({ target: z.string(), n, reason: z.enum(["dropped", "superseded"]), revision: z.number().int().positive() }).strict()),
  stopAt: z.literal("prepared"),
  reportMode: z.enum(["changes", "decisions-only", "quiet"]),
  outcome: z.string().max(4_000).nullable(),
  /** A dropped criterion keeps its id, so `drop c2` typed from an old report never names a newer criterion. */
  criteria: z.array(z.object({ id: z.string(), text: z.string().max(4_000),
    binding: z.union([z.object({ kind: z.literal("targets"), n: z.array(z.number().int().positive()) }).strict(), z.object({ kind: z.literal("effort") }).strict()]),
    addedInRevision: z.number().int().positive(), droppedInRevision: z.number().int().positive().nullable() }).strict()),
  /**
   * Each answered decision, as the answer read. A lifecycle answer lists the PRs it declined, which aren't asked again
   * in this instruction; its grants are already in `include`. Workers get the answers for their PRs in the work order.
   */
  answers: z.array(z.object({ decisionId: z.string(), n: z.number().int().positive(), subkind: z.enum(["mark-ready", "request-review"]).nullable(),
    question: z.string(), answer: z.string().max(4_000), targets: z.array(z.string()), declined: z.array(z.string()), revision: z.number().int().positive() }).strict()),
}).strict();
export type InstructionScope = z.infer<typeof instructionScopeSchema>;
type Grant = InstructionScope["include"][number];

/** What a command must know about a numbered PR. */
export type CommandRow = {
  finished: boolean;
  /** Authored by someone else: a range or `all` grants it only local effects until a command names it. */
  teammate: boolean;
  /** A v2 system issue, which `retry N` starts over. */
  issue: boolean;
  /** Paused by `stop N` or a deleted work order, which `retry N` resumes. */
  stopped: boolean;
  /** Our attempt's claim on the PR. */
  claim: { status: "launching" | "running" | "uncertain"; threadId: string | null } | null;
};
const NO_ROW: CommandRow = { finished: false, teammate: false, issue: false, stopped: false, claim: null };
export type OpenDecision = { n: number; options: readonly string[]; targets: readonly number[] };
export type CommandContext = {
  effortId: string;
  /** The snapshot the surface rendered; numbers resolve only against it. */
  snapshot: { id: string; effortId: string; stale: boolean; rows: readonly { n: number; target: string }[] } | null;
  /** Every number the effort ever issued. Numbers are permanent, so one outside the snapshot still names one PR. */
  issued: ReadonlyMap<number, string>;
  rows: ReadonlyMap<string, CommandRow>;
  holds: PrHolds;
  instruction: InstructionScope | null;
  /** The effort's newest instruction revision, active or not, or 0. Revisions never repeat, so a stale r1 can't match a new one. */
  lastRevision: number;
  expectedRevision?: number;
  decisions: readonly OpenDecision[];
  /** The effort that owns a PR now, this one included, or null. A number outlives membership, so a numbered PR may have left or moved. */
  ownerOf(target: string): { effortId: string; name: string } | null;
};
export type CommandTarget = { target: string; n: number | null };
const INTERVENTIONS = ["refresh", "recheck", "reset", "stop", "retry"] as const;
export type Intervention = CommandTarget & { action: (typeof INTERVENTIONS)[number]; release: boolean };
export type DecisionAnswer = { decision: number } & ({ option: string } | { numbers: number[] } | { text: string });
const targetsSchema = z.array(z.object({ target: z.string(), n }).strict());
/**
 * The acknowledgment as parts, for a surface that draws it: the text lines say the same for the thread and the CLI. `kept` rows a range
 * reached were already included and keep their effects; `stillIncluded` rows weren't named; `leftAlone` rows are out for this instruction
 * only; `held` rows are skipped until released, whatever the instruction. `starting` is each row's next step and where it would run.
 */
export const ackPartsSchema = z.object({
  added: z.array(z.object({ verb: z.string(), targets: targetsSchema }).strict()), kept: targetsSchema, stillIncluded: targetsSchema, leftAlone: targetsSchema,
  held: targetsSchema, holds: z.array(z.object({ targets: targetsSchema, reason: z.string() }).strict()), released: targetsSchema, superseded: targetsSchema,
  dropped: targetsSchema, effects: z.array(z.object({ targets: targetsSchema, effects: z.array(z.enum(EFFECTS)) }).strict()),
  /** What no row this command added may do: a lifecycle effect it didn't grant, or one a narrowing took off. */
  notGranted: z.array(z.enum(EFFECTS)),
  interventions: z.array(z.object({ action: z.enum(INTERVENTIONS), release: z.boolean(), targets: targetsSchema }).strict()),
  answers: z.array(z.object({ n: z.number().int().positive(), answer: z.string() }).strict()),
  starting: z.array(z.object({ targets: targetsSchema, step: z.string(), resource: z.object({ kind: z.string(), reason: z.string().nullable() }).strict().nullable() }).strict()),
  /** A command never merges: merge has its own fresh preview. */
  merge: z.literal(false),
}).strict();
export type AckParts = z.infer<typeof ackPartsSchema>;
/** A command that answers only: its parts are its answers and what they start. */
export const NO_PARTS: Omit<AckParts, "answers" | "starting"> = { added: [], kept: [], stillIncluded: [], leftAlone: [], held: [], holds: [], released: [],
  superseded: [], dropped: [], effects: [], notGranted: [], interventions: [], merge: false };
/** What a command or an answer returns to the surface that sent it. */
export const effortCommandResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("clarify"), message: z.string(), normalized: z.string().nullable() }),
  z.object({ kind: z.literal("admit"), normalized: z.string(), acknowledgment: z.array(z.string()),
    /** Absent from a result journaled before parts existed. */
    parts: ackPartsSchema.optional(),
    /** Outcome, Validated, Still needed, and Needs a decision; null with no active instruction. */
    rollup: z.array(z.string()).nullable(),
    /** The active instruction's revision after the command. */
    revision: z.number().nullable(),
    /** Ready rows whose fresh merge preview the surface opens; the command grants no merge. */
    mergePreviews: z.array(z.object({ target: z.string(), n: z.number().nullable() })) }),
  /** A roster answer held for Undo: it is admitted at `until` unless taken back first, and nothing it answers changes until then. */
  z.object({ kind: z.literal("pending"), requestId: z.string(), text: z.string(), decisions: z.array(z.number()), until: z.number() }),
]);
export type EffortCommandResult = z.infer<typeof effortCommandResultSchema>;
export type CommandResult =
  | { kind: "clarify"; message: string; normalized: string | null }
  | {
    kind: "admit"; normalized: string; acknowledgment: string[];
    /** The acknowledgment as parts, less the answers and next steps its admission adds. */
    parts: Omit<AckParts, "answers" | "starting">;
    /** The next instruction revision, or null when the command leaves the instruction as it was. */
    instruction: InstructionScope | null;
    cancel: boolean;
    holds: (CommandTarget & { reason: string })[]; releases: CommandTarget[];
    interventions: Intervention[]; recheckLaunches: boolean; postRoster: boolean;
    /** Targets whose fresh merge preview the surface opens; the command grants no merge. */
    mergePreviews: CommandTarget[];
    answers: DecisionAnswer[];
  };

type Head =
  | { op: "work"; verb: Verb }
  | { op: "narrow"; remove: Effect[]; phrase: string }
  | { op: "report"; mode: ReportMode; phrase: string }
  | { op: "answer"; decision: number }
  | { op: "undo"; decision: number | null }
  | { op: "mark-ready" | "request-review" | "hold" | "release" | "stop" | "cancel" | "retry" | "refresh" | "recheck" | "recheck-launches" | "reset" | "drop" | "merge" | "post-roster" | "outcome" | "done-when" };
const decisionsOnly: Head = { op: "report", mode: "decisions-only", phrase: "decisions only" };
const noReply: Head = { op: "narrow", remove: ["pr-reply"], phrase: "don't reply" };
const noRerun: Head = { op: "narrow", remove: ["rerun-checks"], phrase: "no rerun" };
/** The closed verb set, longest phrase first. */
const HEADS = ([
  ["tell me only what needs a decision", decisionsOnly], ["only tell me what needs a decision", decisionsOnly], ["decisions only", decisionsOnly],
  ["quiet", { op: "report", mode: "quiet", phrase: "quiet" }],
  ["move", { op: "work", verb: "move forward" }], ["advance", { op: "work", verb: "move forward" }], ["prepare", { op: "work", verb: "move forward" }],
  ["rebase", { op: "work", verb: "rebase" }], ["update branch", { op: "work", verb: "rebase" }], ["resolve conflicts", { op: "work", verb: "rebase" }],
  ["fix ci", { op: "work", verb: "fix ci" }], ["fix checks", { op: "work", verb: "fix ci" }],
  ["address review feedback", { op: "work", verb: "address review" }], ["address review", { op: "work", verb: "address review" }], ["address feedback", { op: "work", verb: "address review" }],
  ["mark", { op: "mark-ready" }], ["request review", { op: "request-review" }],
  ["no push", { op: "narrow", remove: ["push"], phrase: "no push" }],
  ["local only", { op: "narrow", remove: EFFECTS.filter((effect) => !LOCAL.includes(effect)), phrase: "local only" }],
  ["don't reply", noReply], ["do not reply", noReply], ["no replies", noReply], ["no rerun", noRerun], ["no reruns", noRerun], ["don't rerun", noRerun],
  ["hold", { op: "hold" }], ["release", { op: "release" }], ["stop", { op: "stop" }], ["cancel", { op: "cancel" }], ["retry", { op: "retry" }],
  ["refresh", { op: "refresh" }], ["recheck launches", { op: "recheck-launches" }], ["recheck", { op: "recheck" }], ["reset", { op: "reset" }],
  ["drop", { op: "drop" }], ["remove", { op: "drop" }], ["merge", { op: "merge" }], ["post roster", { op: "post-roster" }],
  ["outcome", { op: "outcome" }], ["done when", { op: "done-when" }], ["undo", { op: "undo", decision: null }],
] satisfies [string, Head][]).map(([phrase, head]) => [phrase.split(" "), head] as const).sort((a, b) => b[0].length - a[0].length);
const FILLERS = new Set(["and", "also", "add", "then", "please", "for", "on", "in", "the", "pr", "prs", "row", "rows", "number", "numbers", "of", "now", "with"]);
const INCLUDES = new Set<Head["op"]>(["work", "mark-ready", "request-review"]);
const TARGETED = new Set<Head["op"]>(["work", "mark-ready", "request-review", "hold", "release", "retry", "refresh", "recheck", "reset", "merge"]);
const UNTARGETED = new Set<Head["op"]>(["report", "recheck-launches", "post-roster", "outcome", "undo"]);
const EXCLUDING = new Set(["except", "skip", "without", "leave"]);

type Token = { kind: "url" | "ref" | "range" | "hash" | "num" | "login" | "word" | "sep" | "soft" | "other"; text: string; word: string; start: number; end: number };
const TOKEN = /(?<url>https?:\/\/[^\s,;]*[^\s,;.)])|(?<ref>[\w.-]+(?:\/[\w.-]+)?#\d+)|(?<range>\d+\s*(?:\.\.|[-–—])\s*\d+)|(?<hash>#\d+)|(?<num>\d+)|(?<login>@[\w-]+)|(?<word>[a-z][a-z0-9'’]*)|(?<sep>[;\n]|\.(?=\s|$))|(?<soft>[,:])|(?<space>[^\S\n]+)|(?<other>.)/giu;
function tokenize(text: string): Token[] {
  return [...text.matchAll(TOKEN)].flatMap((match) => {
    const kind = Object.entries(match.groups!).find(([, value]) => value !== undefined)![0] as Token["kind"] | "space";
    return kind === "space" ? [] : [{ kind, text: match[0], word: match[0].toLowerCase().replaceAll("’", "'"), start: match.index, end: match.index + match[0].length }];
  });
}

type Atom = { kind: "n"; n: number; hash: boolean } | { kind: "range"; from: number; to: number } | { kind: "all" } | { kind: "url"; url: string } | { kind: "ref"; repo: string; number: number };
type Clause = { head: Head; include: Atom[]; exclude: { atom: Atom; marker: string }[]; flags: Set<string>; text: string | null; logins: string[]; criteria: string[]; option: string | null;
  /** A clause after a hold reason's comma that names rows or a verb without starting as a command; `rows` when it is bare rows. */
  afterReason: { text: string; rows: boolean } | null };

/** Clauses start at a verb and run to the next verb or a hard break (`;`, a newline, or a sentence end). */
function parse(source: string, decisions: readonly OpenDecision[]) {
  const tokens = tokenize(source);
  const clauses: Clause[] = [];
  const unknown: string[] = [];
  const loose: string[] = [];
  let looseExclusion = false;
  let replace = false;
  let clause: Clause | null = null;
  let excluding: string | null = null;
  const end = (from: number, atComma: boolean) => {
    let to = from;
    while (to < tokens.length && tokens[to]!.kind !== "sep" && !(atComma && tokens[to]!.text === ",")) to++;
    return to;
  };
  const slice = (from: number, to: number) => from >= to ? "" : source.slice(tokens[from]!.start, tokens[to - 1]!.end).trim();
  function atomAt(i: number): { atom: Atom; last: number } | null {
    const token = tokens[i];
    if (token?.kind === "num") return tokens[i + 1]?.word === "to" && tokens[i + 2]?.kind === "num"
      ? { atom: { kind: "range", from: Number(token.text), to: Number(tokens[i + 2]!.text) }, last: i + 2 }
      : { atom: { kind: "n", n: Number(token.text), hash: false }, last: i };
    if (token?.kind === "hash") return { atom: { kind: "n", n: Number(token.text.slice(1)), hash: true }, last: i };
    if (token?.kind === "range") {
      const [from, to] = token.text.split(/\s*(?:\.\.|[-–—])\s*/u).map(Number);
      return { atom: { kind: "range", from: from!, to: to! }, last: i };
    }
    if (token?.kind === "url") return { atom: { kind: "url", url: token.text }, last: i };
    if (token?.kind === "ref") {
      const at = token.text.lastIndexOf("#");
      return { atom: { kind: "ref", repo: token.word.slice(0, at), number: Number(token.text.slice(at + 1)) }, last: i };
    }
    return token?.word === "all" ? { atom: { kind: "all" }, last: i } : null;
  }
  const decisionAt = (i: number) => {
    const match = tokens[i]?.kind === "word" ? /^d(\d+)$/u.exec(tokens[i]!.word) : null;
    return match ? Number(match[1]) : null;
  };
  function headAt(i: number): { head: Head; length: number } | null {
    for (const [words, head] of HEADS) if (words.every((word, k) => tokens[i + k]?.kind === "word" && tokens[i + k]!.word === word)) return { head, length: words.length };
    const decision = decisionAt(i);
    return decision === null ? null : { head: { op: "answer", decision }, length: 1 };
  }
  /** Whether the text from `i` reads as grammar: a verb, `only` before a work verb, or an exclusion, after any filler. */
  function commandAt(i: number): boolean {
    while (tokens[i]?.kind === "word" && FILLERS.has(tokens[i]!.word)) i++;
    const word = tokens[i]?.kind === "word" ? tokens[i]!.word : "";
    return headAt(i) !== null || (word === "only" && headAt(i + 1)?.head.op === "work") || EXCLUDING.has(word) || (word === "but" && tokens[i + 1]?.word === "not");
  }
  /** Whether `from` to `to` holds rows and filler only, which the grammar would read as bare rows. */
  function rowsOnly(from: number, to: number): boolean {
    let rows = false;
    for (let i = from; i < to; i++) {
      const atom = atomAt(i);
      if (atom) { rows = true; i = atom.last; } else if (!(tokens[i]!.kind === "word" && FILLERS.has(tokens[i]!.word))) return false;
    }
    return rows;
  }
  /** Whether `from` to `to` names a row or a verb anywhere. */
  function namesGrammar(from: number, to: number): boolean {
    for (let i = from; i < to; i++) if (atomAt(i) || headAt(i)) return true;
    return false;
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "sep") { clause = null; excluding = null; continue; }
    if (token.text === ":" && (clause?.head.op === "outcome" || clause?.head.op === "done-when") && clause.text === null) {
      const to = end(i + 1, false);
      clause.text = slice(i + 1, to);
      i = to - 1;
      continue;
    }
    if (token.kind === "soft") continue;
    const atom = atomAt(i);
    if (atom) {
      if (!clause) loose.push(slice(i, atom.last + 1));
      else if (excluding) clause.exclude.push({ atom: atom.atom, marker: excluding });
      else clause.include.push(atom.atom);
      i = atom.last;
      continue;
    }
    if (token.kind === "login" && clause?.flags.has("from")) { clause.logins.push(token.text.slice(1)); continue; }
    const word = token.kind === "word" ? token.word : null;
    if (word && clause) {
      const { op } = clause.head;
      if ((word === "forward" && clause.head.op === "work" && clause.head.verb === "move forward") || (word === "ready" && op === "mark-ready")
        || (word === "from" && op === "request-review") || (word === "release" && op === "reset" && !atomAt(i + 1))) { clause.flags.add(word); continue; }
      if (word === "review" && op === "mark-ready" && clause.flags.has("ready")) continue;
      if (word === "because" && op === "hold") {
        // A reason runs past a comma until the next clause reads as a command. Free text continues it; a clause naming rows or a verb
        // anywhere could be either, and the reason would swallow a command, so it asks.
        let to = end(i + 1, true);
        while (tokens[to]?.text === ",") {
          const next = end(to + 1, true);
          if (next === to + 1 || commandAt(to + 1)) break;
          if (namesGrammar(to + 1, next)) { clause.afterReason = { text: slice(to + 1, next), rows: rowsOnly(to + 1, next) }; break; }
          to = next;
        }
        clause.text = slice(i + 1, to);
        i = to - 1;
        continue;
      }
      if (op === "drop" && /^c\d+$/u.test(word)) { clause.criteria.push(word); continue; }
    }
    const head = word ? headAt(i) : null;
    if (head) {
      // Only `move` needs `forward`; `advance` and `prepare` are whole verbs.
      clause = { head: head.head, include: [], exclude: [], flags: new Set(token.word === "move" ? ["move"] : []), text: null, logins: [], criteria: [], option: null, afterReason: null };
      clauses.push(clause);
      excluding = null;
      i += head.length - 1;
      const started = head.head;
      if (started.op === "answer") {
        const options = decisions.find((decision) => decision.n === started.decision)?.options ?? [];
        const next = tokens[i + 1];
        if (next?.kind === "word" && options.some((option) => option.toLowerCase() === next.word)) { clause.option = next.text; i++; }
        // `none` names no rows, unless the decision offers an option by that name.
        else if (next?.word === "none") { clause.flags.add("none"); i++; }
        else if (next && next.kind !== "sep" && next.kind !== "soft" && !atomAt(i + 1)) {
          const to = end(i + 1, false);
          clause.text = slice(i + 1, to);
          i = to - 1;
        }
      }
      const undone = started.op === "undo" ? decisionAt(i + 1) : null;
      if (undone !== null) { clause.head = { op: "undo", decision: undone }; i++; }
      continue;
    }
    if (word && EXCLUDING.has(word)) { looseExclusion ||= !clause; excluding = word === "leave" ? "leave alone" : word; continue; }
    if (word === "alone" && excluding === "leave alone") { excluding = null; continue; }
    if (word === "but" && tokens[i + 1]?.word === "not") { looseExclusion ||= !clause; excluding = "but not"; i++; continue; }
    if (word === "but" && clause?.include.at(-1)?.kind === "all" && !excluding) { excluding = "all but"; continue; }
    // `only` leads a work verb and `instead` trails one; anywhere else, replacing the instruction would be a guess.
    if ((word === "only" && headAt(i + 1)?.head.op === "work") || (word === "instead" && clause?.head.op === "work")) { replace = true; continue; }
    if (word && FILLERS.has(word)) continue;
    unknown.push(token.text);
  }
  return { clauses, unknown, loose, looseExclusion, replace };
}

type Ref = CommandTarget & { named: boolean; owner: { effortId: string; name: string } | null; outside: boolean };
type Resolved = { clause: Clause; refs: Ref[]; excluded: (Ref & { marker: string })[] };

const q = (text: string) => `"${text}"`;
const EFFECT_LABEL: Record<Effect, string> = SHARED_EFFECT_LABEL;
const REPORT_LABEL: Record<ReportMode, string> = { changes: "changes", "decisions-only": "decisions only", quiet: "quiet" };

function render({ clause, refs, excluded }: Resolved, replace: boolean): string {
  const targets = formatTargets(refs);
  const except = excluded.length ? ` except ${formatTargets(excluded)}` : "";
  const { head } = clause;
  switch (head.op) {
    case "work": return `${replace ? "only " : ""}${head.verb === "move forward" ? `move ${targets} forward` : `${head.verb} ${targets}`}${except}`;
    case "narrow": return `${head.phrase}${targets ? ` for ${targets}` : ""}`;
    case "report": return head.phrase;
    case "answer": return `D${head.decision} ${clause.option ?? clause.text ?? (clause.flags.has("none") ? "none" : formatTargets(refs))}`;
    case "mark-ready": return `mark ${targets} ready`;
    case "request-review": return `request review ${targets} from ${clause.logins.map((login) => `@${login}`).join(" ")}`;
    case "hold": return `hold ${targets}${clause.text ? ` because ${clause.text}` : ""}`;
    case "reset": return `reset ${targets}${clause.flags.has("release") ? " release" : ""}`;
    case "drop": return `drop ${[targets, ...clause.criteria].filter(Boolean).join(", ")}`;
    case "recheck-launches": return "recheck launches";
    case "post-roster": return "post roster";
    case "outcome": return `outcome: ${clause.text ?? ""}`;
    case "done-when": return `done when${targets ? ` ${targets}` : ""}: ${clause.text ?? ""}`;
    case "undo": return `undo${head.decision === null ? "" : ` D${head.decision}`}`;
    default: return `${head.op}${targets ? ` ${targets}` : ""}${except}`;
  }
}

/**
 * Why `action N` is refused on this row, or null when the grammar admits it. The parser and the roster's row menu both read
 * it, so the menu never offers what a typed command would clarify.
 */
export function interventionRefusal(action: Intervention["action"], item: CommandTarget, state: Pick<CommandRow, "issue" | "stopped" | "claim">,
  included: boolean, release: boolean): string | null {
  const name = formatTargets([item]);
  if (action === "stop" && state.claim?.status !== "running") return `stop ${name} interrupts a running turn, and none of ours is running on ${name}. To keep it from starting, hold ${name}.`;
  if (action === "retry" && !(included && (state.issue || state.stopped))) return `retry ${name} restarts a system issue or a stopped row, and ${name} is neither.`;
  if ((action === "refresh" || action === "recheck") && item.n === null && !included) return `${name} isn't on this roster.`;
  if (action === "reset") {
    const uncertain = state.claim?.status === "launching" || state.claim?.status === "uncertain";
    if (!included) return `reset ${name} rebuilds a row's work in the instruction, and ${name} isn't in it. refresh ${name} re-reads it.`;
    if (uncertain && !release) return `${name}'s launch is ${state.claim!.status === "launching" ? "still launching" : "uncertain"}${state.claim!.threadId
      ? `; its likely worker is ${state.claim!.threadId}` : ""}. Reset drops that claim only if you confirm no worker is writing: reset ${name} release`;
    if (!uncertain && release) return `${name} has no uncertain launch to release. Send: reset ${name}`;
  }
  return null;
}
/** Every command to an effort on legacy launchers is refused with this. */
export const legacyRefusal = (effortName: string) => `${effortName} runs on legacy launchers. Move it to its roster before instructing it there.`;
/** `stop N` in a dry run, which writes nothing to BB: the worker's thread to stop yourself. */
export const dryRunStopRefusal = (targets: string, threads: string) => `v2 execution is a dry run, so v2 stops no worker. Stop ${targets} in ${threads} yourself.`;

const ACK_LINES = 12;
const HELD = ["Held, skipped until released", "Now held:"];
/** At most 12 lines, folding the rest into a pointer to the roster; lines naming held PRs are kept before any other. */
export function capAcknowledgment(lines: readonly string[]): string[] {
  if (lines.length <= ACK_LINES) return [...lines];
  const held = (line: string) => HELD.some((prefix) => line.startsWith(prefix));
  const keep = new Set([...lines.keys()].sort((a, b) => Number(held(lines[b]!)) - Number(held(lines[a]!)) || a - b).slice(0, ACK_LINES - 1));
  const shown = lines.filter((_, index) => keep.has(index));
  return [...shown, `+${lines.length - shown.length} more lines; open the roster for the rest`];
}

/** Read one command against the effort's snapshot and active instruction; admit all of it, or clarify and admit nothing. */
export function interpretEffortCommand(text: string, ctx: CommandContext): CommandResult {
  const issues: string[] = [];
  const issue = (message: string) => { if (!issues.includes(message)) issues.push(message); };
  const parsed = parse(text, ctx.decisions);
  const row = (target: string) => ctx.rows.get(target) ?? NO_ROW;
  const numberOf = new Map([...ctx.issued].map(([number, target]) => [target, number]));
  const snapshotRows = ctx.snapshot?.rows ?? [];
  const prev = ctx.instruction;
  const revision = ctx.lastRevision + 1;
  const openNumbers = snapshotRows.filter((item) => !row(item.target).finished).map((item) => ({ target: item.target, n: item.n }));

  function snapshotUsable(): boolean {
    if (!ctx.snapshot) return issue("Numbers need the roster you are looking at. Reload the roster and send the command again."), false;
    if (ctx.snapshot.effortId !== ctx.effortId || ctx.snapshot.stale)
      return issue(`Roster ${ctx.snapshot.id} belongs to ${ctx.snapshot.stale ? "an effort merged into another" : "another effort"}, so its numbers don't apply here. Reload this effort's roster.`), false;
    return true;
  }
  const ref = (target: string, named: boolean): Ref => {
    const owner = ctx.ownerOf(target);
    return { target, n: numberOf.get(target) ?? null, named, owner: owner && owner.effortId !== ctx.effortId ? owner : null, outside: owner === null };
  };
  function resolve(atom: Atom, decision: OpenDecision | null): Ref[] {
    if (decision) {
      const numbers = atom.kind === "all" ? [...decision.targets] : atom.kind === "range" ? decision.targets.filter((item) => item >= atom.from && item <= atom.to)
        : atom.kind === "n" ? [atom.n] : [];
      if (atom.kind === "url" || atom.kind === "ref") issue(`Answer D${decision.n} with row numbers.`);
      const outside = numbers.filter((item) => !decision.targets.includes(item));
      if (outside.length) issue(`D${decision.n} asks about ${decision.targets.join(", ")}; ${outside.join(", ")} ${outside.length === 1 ? "isn't" : "aren't"} part of it.`);
      return numbers.filter((item) => decision.targets.includes(item)).map((item) => ({ target: ctx.issued.get(item) ?? String(item), n: item, named: false, owner: null, outside: false }));
    }
    if (atom.kind === "url") {
      const target = canonicalPrUrl(atom.url);
      return target ? [ref(target, true)] : (issue(`${atom.url} isn't a GitHub pull request URL.`), []);
    }
    if (atom.kind === "ref") {
      const matches = [...numberOf.keys()].filter((target) => {
        const parsed = prTarget(target);
        return parsed?.number === atom.number && (atom.repo.includes("/") ? parsed.slug === atom.repo : parsed.name === atom.repo);
      });
      if (matches.length === 1) return [ref(matches[0]!, true)];
      if (matches.length > 1) return issue(`${atom.repo}#${atom.number} matches more than one repository here. Use owner/repo#${atom.number}.`), [];
      const target = atom.repo.includes("/") ? canonicalPrUrl(`https://github.com/${atom.repo}/pull/${atom.number}`) : null;
      return target ? [ref(target, true)] : (issue(`${atom.repo}#${atom.number} isn't on this roster. Use owner/repo#${atom.number} or its URL.`), []);
    }
    if (!snapshotUsable()) return [];
    const inSnapshot = (number: number) => snapshotRows.find((item) => item.n === number)?.target;
    const highest = Math.max(0, ...ctx.issued.keys());
    if (atom.kind === "all") return snapshotRows.map((item) => ref(item.target, false));
    if (atom.kind === "range") {
      if (atom.from > atom.to || atom.from < 1) return issue(`${atom.from}-${atom.to} isn't a range of row numbers.`), [];
      const unissued = Math.max(atom.from, highest + 1);
      if (atom.to > highest) issue(`${unissued === atom.to ? `${unissued} was` : `${unissued}-${atom.to} were`} never issued in this effort; its highest number is ${highest}.`);
      return snapshotRows.filter((item) => item.n >= atom.from && item.n <= atom.to).map((item) => ref(item.target, false));
    }
    const target = inSnapshot(atom.n) ?? ctx.issued.get(atom.n);
    if (!target) return issue(`${atom.n} was never issued in this effort; its highest number is ${highest}.`), [];
    const collision = atom.hash ? [...numberOf].find(([other, number]) => number !== atom.n && prTarget(other)?.number === atom.n) : undefined;
    if (collision) issue(`#${atom.n} could mean row ${atom.n} or ${prTarget(collision[0])!.slug} #${atom.n}. Write ${atom.n} for the row or ${prTarget(collision[0])!.name}#${atom.n} for the PR.`);
    return [ref(target, true)];
  }
  /** One ref per target; a target any atom names explicitly counts as named. */
  const unique = <T extends Ref>(refs: T[]): T[] => [...refs.reduce((map, item) => {
    const seen = map.get(item.target);
    return map.set(item.target, seen ? { ...seen, named: seen.named || item.named } : item);
  }, new Map<string, T>()).values()];

  // Read every clause before changing anything.
  if (parsed.unknown.length) issue(`I didn't recognize ${parsed.unknown.map(q).join(", ")}.`);
  if (parsed.loose.length) issue(`${parsed.loose.join(", ")} ${parsed.loose.length === 1 ? "needs" : "need"} a verb, for example: move ${parsed.loose.join(", ")} forward, hold ${parsed.loose[0]}, or refresh ${parsed.loose[0]}.`);
  const exclusionHint = "Exclusions apply to the rows a work verb adds, as in: move 1-6 forward, leave 3 alone. To take a row out of the instruction, drop it; to stop it everywhere, hold it.";
  if (parsed.looseExclusion) issue(exclusionHint);
  const strays: (Ref & { marker: string })[] = [];
  const resolved: Resolved[] = parsed.clauses.map((clause) => {
    const { head } = clause;
    const decision = head.op === "answer" ? ctx.decisions.find((item) => item.n === head.decision) ?? null : null;
    const excluded = unique(clause.exclude.flatMap(({ atom, marker }) => resolve(atom, decision).map((item) => ({ ...item, marker }))));
    const reached = unique(clause.include.flatMap((atom) => resolve(atom, decision)));
    // Outside a work verb, an exclusion only trims its own clause's rows (`hold 4-6 except 5`); one that trims none would go unread.
    const stray = INCLUDES.has(head.op) ? [] : excluded.filter((item) => !reached.some((other) => other.target === item.target));
    strays.push(...stray);
    return { clause, refs: reached.filter((item) => !excluded.some((other) => other.target === item.target)), excluded: excluded.filter((item) => !stray.includes(item)) };
  });
  if (strays.length) {
    issue(exclusionHint);
    // The copyable reading carries them on the first work verb, so sending it leaves those rows out.
    const first = resolved.find((item) => INCLUDES.has(item.clause.head.op));
    if (first) {
      first.excluded = unique([...first.excluded, ...strays]);
      first.refs = first.refs.filter((item) => !strays.some((other) => other.target === item.target));
    }
  }
  const answered = new Map<number, Resolved>();
  for (const item of resolved) {
    const { clause, refs } = item;
    const { head } = clause;
    if (TARGETED.has(head.op) && clause.include.length === 0) {
      const example = (head.op === "work" ? openNumbers : openNumbers.slice(0, 1)).map((item) => ({ ...item, named: false, owner: null, outside: false }));
      issue(`Name the rows, for example: ${render({ clause, refs: example, excluded: [] }, false)}. Nothing was admitted.`);
    }
    if (UNTARGETED.has(head.op) && clause.include.length > 0) issue(`${q(render({ clause, refs: [], excluded: [] }, false))} takes no rows.`);
    if (clause.flags.has("move") && !clause.flags.has("forward")) issue(`Did you mean: move ${formatTargets(refs)} forward?`);
    if (head.op === "mark-ready" && !clause.flags.has("ready")) issue(`Did you mean: mark ${formatTargets(refs)} ready?`);
    if (head.op === "request-review" && clause.logins.length === 0) issue(`Name the reviewers: request review ${formatTargets(refs) || "N"} from @login.`);
    if ((head.op === "outcome" || head.op === "done-when") && !clause.text) issue(`${head.op === "outcome" ? "outcome" : "done when"} needs its text after a colon, for example: ${head.op === "outcome" ? "outcome: readers can filter shelves by genre" : "done when 2: the shelf test passes"}.`);
    if (head.op === "answer" && !ctx.decisions.some((item) => item.n === head.decision)) issue(`D${head.decision} isn't an open decision.`);
    else if (head.op === "answer" && clause.option === null && clause.text === null && clause.include.length === 0 && !clause.flags.has("none"))
      issue(`D${head.decision} needs an answer: an option, row numbers, all, none, or text.`);
    else if (head.op === "answer" && clause.flags.has("none") && clause.include.length > 0) issue(`D${head.decision} can't be none and ${formatTargets(refs)} at once.`);
    if (head.op === "drop" && clause.include.length === 0 && clause.criteria.length === 0) issue("drop needs rows or criteria, for example: drop 4 or drop c1.");
    if (head.op === "cancel" && clause.include.length > 0) issue(`cancel takes no rows. To take ${formatTargets(refs)} out, drop ${formatTargets(refs)}; to interrupt a running turn, stop ${formatTargets(refs)}.`);
    if (clause.afterReason) issue(clause.afterReason.rows
      ? `${q(clause.afterReason.text)} follows a hold reason, so it could be more rows or more of the reason. To hold it too, send: ${render(item, false)}. To keep it in the reason, leave out the comma before it.`
      : `${q(clause.afterReason.text)} follows a hold reason and names a row or a verb, so it could be a command or more of the reason. To run it, end the reason with a semicolon. To keep it in the reason, leave out the comma before it.`);
    // Two answers to one decision contradict each other, so neither runs.
    if (head.op === "answer") {
      const first = answered.get(head.decision);
      if (first) issue(`This reply answers D${head.decision} twice, ${q(render(first, false))} and ${q(render(item, false))}. Send one answer.`);
      else answered.set(head.decision, item);
    }
    // No answer waits before it takes effect, so there is none for undo to take back.
    if (head.op === "undo") issue(`Undo isn't available${head.decision === null ? "" : ` for D${head.decision}`}: an answer takes effect as soon as it's admitted.`);
  }
  const foreign = resolved.flatMap(({ refs, excluded }) => [...refs, ...excluded]).filter((item) => item.owner);
  if (foreign.length) {
    const owners = [...new Map(foreign.map((item) => [item.owner!.effortId, item.owner!.name])).entries()];
    const here = resolved.map((item) => ({ ...item, refs: item.refs.filter((other) => !other.owner) })).filter((item) => item.refs.length || !TARGETED.has(item.clause.head.op));
    issue([`Nothing was admitted: ${formatTargets(foreign)} ${foreign.length === 1 ? "belongs" : "belong"} to other efforts. Send each part in that effort's parent thread:`,
      ...owners.map(([id, name]) => `${name}: ${resolved.map((item) => ({ ...item, refs: item.refs.filter((other) => other.owner?.effortId === id) })).filter((item) => item.refs.length)
        .map((item) => render(item, false)).join("; ")}`),
      ...(here.length ? [`Here: ${here.map((item) => render(item, parsed.replace)).join("; ")}`] : [])].join("\n"));
  }

  // Apply the instruction clauses to a copy of the active scope.
  const base: InstructionScope = prev ?? { revision: 0, include: [], exclude: [], removed: [], stopAt: "prepared", reportMode: "changes", outcome: null, criteria: [], answers: [] };
  const next = structuredClone(base);
  const inclusions = resolved.filter((item) => INCLUDES.has(item.clause.head.op));
  const excludedHere = unique(inclusions.flatMap((item) => item.excluded)).filter((item) => !item.owner);
  const takenOut = excludedHere.filter((item) => base.include.some((grant) => grant.target === item.target));
  const finished: Ref[] = [];
  const localOnly: Ref[] = [];
  const unchanged: Ref[] = [];
  const leftAlone: Ref[] = [];
  const addedBy: [string, Ref[]][] = [];
  const cancel = resolved.some(({ clause }) => clause.head.op === "cancel" || (clause.head.op === "stop" && clause.include.length === 0));
  const drops = resolved.some(({ clause }) => clause.head.op === "drop");
  if ((cancel || drops) && !prev) issue("No instruction is active, so there is nothing to drop or cancel.");
  // Anything that takes rows or criteria away applies only to the revision its sender saw.
  if ((parsed.replace || cancel || drops || takenOut.length) && prev && ctx.expectedRevision !== undefined && ctx.expectedRevision !== prev.revision)
    issue(`The instruction is now r${prev.revision}, but this command was written against r${ctx.expectedRevision}. Reload the roster and send it again.`);
  if (cancel && resolved.some(({ clause }) => !["cancel", "stop"].includes(clause.head.op) || (clause.head.op === "stop" && clause.include.length > 0)))
    issue("Cancel the instruction on its own, then send the next command.");
  if (parsed.replace && inclusions.length === 0) issue("only and instead replace the included rows with the ones a work verb names, as in: only move 7-9 forward.");
  const superseded: Grant[] = [];
  if (parsed.replace && inclusions.length) {
    const kept = new Set(inclusions.flatMap((item) => item.refs.map((other) => other.target)));
    superseded.push(...next.include.filter((grant) => !kept.has(grant.target)));
    next.include = next.include.filter((grant) => kept.has(grant.target));
    next.removed.push(...superseded.map(({ target, n: number }) => ({ target, n: number, reason: "superseded" as const, revision })));
    next.exclude = [];
  }
  for (const { clause, refs } of inclusions) {
    const { head } = clause;
    const added: Ref[] = [];
    for (const item of refs) {
      if (item.owner) continue;
      if (row(item.target).finished) { finished.push(item); continue; }
      const existing = next.include.find((other) => other.target === item.target);
      // A range or `all` keeps what the instruction already says about a row: that it stays out, or its effects. Naming the row changes them.
      if (!item.named && next.exclude.some((other) => other.target === item.target)) { leftAlone.push(item); continue; }
      if (!item.named && head.op === "work" && existing && existing.addedInRevision !== revision) { unchanged.push(item); continue; }
      const grant = head.op === "work" ? { work: [...VERBS[head.verb].work], effects: [...VERBS[head.verb].effects] }
        : { work: [], effects: [head.op === "mark-ready" ? "mark-ready" : "request-review"] as Effect[] };
      // A range or `all` doesn't reach into a teammate's PR beyond the checkout.
      if (row(item.target).teammate && !item.named && grant.effects.some((effect) => !LOCAL.includes(effect))) {
        grant.effects = grant.effects.filter((effect) => LOCAL.includes(effect));
        localOnly.push(item);
      }
      const reviewers = head.op === "request-review" ? clause.logins : [];
      if (existing) {
        existing.work = WORK_RECIPES.filter((recipe) => existing.work.includes(recipe) || grant.work.includes(recipe));
        existing.effects = EFFECTS.filter((effect) => existing.effects.includes(effect) || grant.effects.includes(effect));
        existing.reviewers = [...new Set([...existing.reviewers, ...reviewers])];
      } else next.include.push({ target: item.target, n: item.n, outsideMembership: item.outside, ...grant, reviewers, addedInRevision: revision });
      next.exclude = next.exclude.filter((other) => other.target !== item.target);
      next.removed = next.removed.filter((other) => other.target !== item.target);
      added.push(item);
    }
    if (added.length) addedBy.push([head.op === "work" ? head.verb : head.op === "mark-ready" ? "mark ready" : `request review from ${clause.logins.map((login) => `@${login}`).join(" ")}`, added]);
  }
  for (const item of excludedHere) {
    next.include = next.include.filter((grant) => grant.target !== item.target);
    if (!next.exclude.some((other) => other.target === item.target)) next.exclude.push({ target: item.target, n: item.n, reason: item.marker });
  }
  const inScope = (item: CommandTarget) => next.include.find((grant) => grant.target === item.target);
  const narrowed: string[] = [];
  const dropped: Grant[] = [];
  const holds: (CommandTarget & { reason: string })[] = [];
  const releases: CommandTarget[] = [];
  const interventions: Intervention[] = [];
  const mergePreviews: CommandTarget[] = [];
  const answers: DecisionAnswer[] = [];
  const notes: string[] = [];
  const addedTargets = unique(addedBy.flatMap(([, refs]) => refs));
  for (const { clause, refs } of resolved) {
    const { head } = clause;
    const plain = refs.filter((item) => !item.owner).map(({ target, n: number }) => ({ target, n: number }));
    switch (head.op) {
      case "narrow": {
        const targets = clause.include.length ? plain : unique([...addedTargets, ...unchanged]);
        if (!targets.length) { issue(`${q(head.phrase)} needs rows, for example: ${head.phrase} for 4.`); break; }
        const missing = targets.filter((item) => !inScope(item));
        if (missing.length) { issue(`${formatTargets(missing)} ${missing.length === 1 ? "isn't" : "aren't"} in the instruction, so ${q(head.phrase)} has nothing to narrow.`); break; }
        for (const item of targets) inScope(item)!.effects = inScope(item)!.effects.filter((effect) => !head.remove.includes(effect));
        narrowed.push(`${formatTargets(targets)} ${head.phrase}`);
        break;
      }
      case "report": next.reportMode = head.mode; break;
      case "outcome": if (clause.text) next.outcome = clause.text; break;
      case "done-when": {
        if (!clause.text) break;
        const missing = plain.filter((item) => !inScope(item) || item.n === null);
        if (missing.length) { issue(`done when binds criteria to numbered rows in the instruction; ${formatTargets(missing)} ${missing.length === 1 ? "isn't" : "aren't"}.`); break; }
        const id = `c${next.criteria.length + 1}`;
        next.criteria.push({ id, text: clause.text, binding: plain.length ? { kind: "targets", n: plain.map((item) => item.n!).sort((a, b) => a - b) } : { kind: "effort" },
          addedInRevision: revision, droppedInRevision: null });
        notes.push(`Criterion ${id}${plain.length ? ` (${formatTargets(plain)})` : ""}: ${clause.text}`);
        break;
      }
      case "drop": {
        const missing = plain.filter((item) => !inScope(item));
        if (missing.length) issue(`${formatTargets(missing)} ${missing.length === 1 ? "isn't" : "aren't"} in the instruction, so there is nothing to drop.`);
        for (const item of plain.filter(inScope)) {
          dropped.push(inScope(item)!);
          next.include = next.include.filter((grant) => grant.target !== item.target);
          next.removed.push({ target: item.target, n: item.n, reason: "dropped", revision });
        }
        for (const id of clause.criteria) {
          const criterion = next.criteria.find((item) => item.id === id && item.droppedInRevision === null);
          if (!criterion) { issue(`${id} isn't an active criterion.`); continue; }
          criterion.droppedInRevision = revision;
          notes.push(`Dropped criterion ${id}: ${criterion.text}`);
        }
        break;
      }
      case "hold": holds.push(...plain.map((item) => ({ ...item, reason: clause.text ?? "" }))); break;
      case "release": releases.push(...plain); break;
      case "merge": mergePreviews.push(...plain); break;
      case "answer": {
        if (clause.option !== null) answers.push({ decision: head.decision, option: clause.option });
        else if (clause.text !== null) answers.push({ decision: head.decision, text: clause.text });
        else answers.push({ decision: head.decision, numbers: refs.map((item) => item.n!).sort((a, b) => a - b) });
        break;
      }
      case "stop": case "retry": case "refresh": case "recheck": case "reset": {
        if (head.op === "stop" && clause.include.length === 0) break;
        for (const item of plain) {
          const included = Boolean(inScope(item) ?? prev?.include.find((grant) => grant.target === item.target));
          const release = head.op === "reset" && clause.flags.has("release");
          const refusal = interventionRefusal(head.op, item, row(item.target), included, release);
          if (refusal) { issue(refusal); continue; }
          interventions.push({ ...item, action: head.op, release });
        }
        break;
      }
    }
  }
  next.include.sort((a, b) => (a.n ?? Infinity) - (b.n ?? Infinity) || a.target.localeCompare(b.target));
  const revised = JSON.stringify(next) !== JSON.stringify(base);
  if (revised && !cancel && next.include.length === 0 && !prev) issue(`No instruction is active yet${finished.length ? `, and ${formatTargets(finished)} ${finished.length === 1 ? "is" : "are"} already done` : ""}. Name open rows with a work verb, for example: move ${formatTargets(openNumbers.slice(0, 3))} forward.`);
  // The reading as a command that parses back to the same thing; a verb missing its rows has none.
  const normalized = resolved.filter((item) => !TARGETED.has(item.clause.head.op) || item.refs.length)
    .map((item) => render(item, parsed.replace && item === inclusions[0])).join("; ");
  if (issues.length) return { kind: "clarify", message: issues.join("\n"), normalized: normalized || null };

  // The acknowledgment: what changed, what stays out, and what a hold keeps waiting.
  const heldNow = (target: string) => holds.some((item) => item.target === target) || (!releases.some((item) => item.target === target) && prHoldFor(target, ctx.holds) !== null);
  const scope = cancel ? prev! : next;
  // Every held PR the instruction includes or this command names: leaving one out doesn't lift its hold.
  const held = [...scope.include, ...excludedHere, ...interventions, ...mergePreviews].filter((item) => heldNow(item.target));
  const draining = superseded.filter((grant) => row(grant.target).claim);
  const recheckLaunches = resolved.some(({ clause }) => clause.head.op === "recheck-launches");
  const postRoster = resolved.some(({ clause }) => clause.head.op === "post-roster");
  const effectGroups = new Map<string, Grant[]>();
  for (const grant of scope.include) {
    const key = grant.effects.map((effect) => EFFECT_LABEL[effect]).join(" · ") || "no effects";
    effectGroups.set(key, [...effectGroups.get(key) ?? [], grant]);
  }
  // What a range reached and left as it was, unless another clause in the command changed it.
  const keptAsIs = unchanged.filter((item) => inScope(item) && !addedTargets.some((other) => other.target === item.target));
  const stillOut = leftAlone.filter((item) => !inScope(item));
  const stillIncluded = revised && prev ? prev.include.filter((grant) => inScope(grant) && ![...addedTargets, ...unchanged].some((item) => item.target === grant.target)) : [];
  const lines = [
    cancel ? `Cancelled instruction r${prev!.revision}. Running turns finish; nothing new starts.`
      : revised ? `Instruction r${revision} · ${next.include.length} PRs · stops at Ready · reports ${REPORT_LABEL[next.reportMode]}` : null,
    ...addedBy.map(([verb, refs]) => `Added: ${formatTargets(refs)} (${verb})`),
    stillIncluded.length ? `Still included: ${formatTargets(stillIncluded)}` : null,
    keptAsIs.length ? `Already included, keeping their effects; name them to change them: ${formatTargets(keptAsIs)}` : null,
    stillOut.length ? `Still left alone this instruction; name them to include them: ${formatTargets(stillOut)}` : null,
    superseded.length ? `Superseded: ${formatTargets(superseded)}${draining.length ? ` (${formatTargets(draining)} ${draining.length === 1 ? "finishes its" : "finish their"} current turn first)` : ""}` : null,
    dropped.length ? `Dropped: ${formatTargets(dropped)}` : null,
    excludedHere.length ? `Left alone this instruction, not a hold: ${formatTargets(excludedHere)}${takenOut.length ? ` (${formatTargets(takenOut)} taken out of it)` : ""}` : null,
    held.length ? `Held, skipped until released (a hold outlasts every instruction): ${formatTargets(held)}` : null,
    revised && !cancel && effectGroups.size ? `Effects: ${[...effectGroups].map(([effects, grants]) => `${formatTargets(grants)} ${effects}`).join("; ")}` : null,
    narrowed.length ? `Narrowed: ${narrowed.join("; ")}` : null,
    localOnly.length ? `Teammate PRs a range reached stay local; name them to allow pushes and replies: ${formatTargets(localOnly)}` : null,
    finished.length ? `Already done: ${formatTargets(finished)}` : null,
    next.include.some((grant) => grant.outsideMembership && grant.addedInRevision === revision)
      ? `Outside membership, membership unchanged: ${formatTargets(next.include.filter((grant) => grant.outsideMembership && grant.addedInRevision === revision))}` : null,
    next.outcome !== prev?.outcome && next.outcome ? `Outcome: ${next.outcome}` : null,
    ...notes,
    // One line per reason, so a range of holds stays one line.
    ...[...new Set(holds.map((item) => item.reason))].map((reason) => `Now held: ${formatTargets(holds.filter((item) => item.reason === reason))}${reason ? ` (${reason})` : ""}`),
    releases.length ? `Released: ${formatTargets(releases)}` : null,
    ...(["refresh", "recheck", "reset", "stop", "retry"] as const).flatMap((action) => {
      const targets = interventions.filter((item) => item.action === action);
      const released = targets.filter((item) => item.release);
      return [targets.length > released.length ? `${action[0]!.toUpperCase()}${action.slice(1)}: ${formatTargets(targets.filter((item) => !item.release))}` : null,
        released.length ? `Reset, releasing the uncertain launch claim: ${formatTargets(released)}` : null];
    }),
    recheckLaunches ? "Recheck launches: read back every uncertain launch" : null,
    postRoster ? "Post roster" : null,
    mergePreviews.length ? `Merge ${formatTargets(mergePreviews)}: open the fresh merge preview from the Ready list. This command grants no merge.` : null,
  ].filter((line): line is string => line !== null);
  const listed = (items: readonly CommandTarget[]) => [...new Map(items.map(({ target, n: number }) => [target, { target, n: number }])).values()]
    .sort((a, b) => (a.n ?? Infinity) - (b.n ?? Infinity) || a.target.localeCompare(b.target));
  const addedGrants = next.include.filter((grant) => addedTargets.some((item) => item.target === grant.target));
  const parts: Omit<AckParts, "answers" | "starting"> = {
    added: addedBy.map(([verb, refs]) => ({ verb, targets: listed(refs) })), kept: listed(keptAsIs), stillIncluded: listed(stillIncluded),
    leftAlone: listed([...excludedHere, ...stillOut]), held: listed(held),
    holds: [...new Set(holds.map((item) => item.reason))].map((reason) => ({ targets: listed(holds.filter((item) => item.reason === reason)), reason })),
    released: listed(releases), superseded: listed(superseded), dropped: listed(dropped),
    effects: revised && !cancel ? [...effectGroups.values()].map((grants) => ({ targets: listed(grants), effects: [...grants[0]!.effects] })) : [],
    notGranted: addedGrants.length ? EFFECTS.filter((effect) => !addedGrants.some((grant) => grant.effects.includes(effect))) : [],
    interventions: INTERVENTIONS.flatMap((action) => [false, true].flatMap((release) => {
      const targets = interventions.filter((item) => item.action === action && item.release === release);
      return targets.length ? [{ action, release, targets: listed(targets) }] : [];
    })),
    merge: false,
  };
  return {
    kind: "admit", normalized, acknowledgment: lines, parts,
    instruction: revised && !cancel ? { ...next, revision } : null, cancel, holds, releases, interventions, recheckLaunches, postRoster, mergePreviews, answers,
  };
}
