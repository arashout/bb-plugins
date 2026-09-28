import {
  BRIEF_STAGES,
  MAX_TITLE_LENGTH,
  nextStepActorSchema,
  summaryResultSchema,
  type BriefStage,
  type NextStepActor,
  type SummaryResult,
} from "./contract.js";

export const SYSTEM_PROMPT = `You write one-paragraph-max operating briefs for software engineering threads, so someone returning after a day away knows what the thread is for and what to do next without reading it.

Return ONLY a JSON object with exactly these keys:

  "title"         A name for this thread, 4-6 words, that someone scanning a sidebar would recognise a day later. Name the work, not the conversation: the subsystem, file, or feature plus what is being done to it. No trailing punctuation, no quotes, no "thread"/"discussion"/"chat", no leading verb like "Add" unless adding is genuinely the whole job.
  "goal"          One line: what this thread is actually trying to achieve. Not the opening prompt restated — the underlying objective, as it stands now.
  "currentState"  What exists now, including half-finished work. Name the concrete artifacts (files, branches, PRs) where the transcript names them.
  "nextStep"      The single most concrete next action, phrased so the reader could start it without thinking. ONE action, not a plan. Empty string if nobody owes this thread an action.
  "nextStepActor" Who has to take that next step. One of: "me" if only the user can (try it and report back, decide between options, reply to someone, merge, grant access), "agent" if the agent could carry on unprompted, "other" if it depends on someone or something outside this thread (a review, a colleague, an upstream fix, a rollout).
  "blockedOn"     The party or artifact the thread is waiting on, when someone could go chase it. Empty string otherwise.
  "constraints"   Facts learned during the thread that would break a naive re-plan: API limits, rejected approaches, assumptions proven wrong. Empty string if none.
  "stage"         One of: "discovery", "planning", "implementation", "review".

Rules:
- Every field is a string except "nextStepActor", which is one of the three words above. Keep each to one or two lines.
- "title" describes what the thread turned out to be about, not what its opening message asked for. A thread that set out to fix a test and ended up rewriting the scheduler is named for the scheduler.
- Omit "nextStepActor" entirely when "nextStep" is the empty string — there is no actor for a step that does not exist.
- When "blockedOn" is non-empty, "nextStepActor" is "other".
- A thread is finished when nobody owes it an action. For any candidate next step, ask: must a person or team actually do this, will it not happen on its own, and would it be dropped if this brief did not record it? Yes to all three — that is "nextStep", and the thread is not done. Otherwise "nextStep" is the empty string. Never invent one; a brief that manufactures work devalues every real item next to it.
- An action can be owed outside the chat, and those are the ones that get silently dropped: a PR open for review or merge, a patch carried on a fork or side branch until it lands upstream, a temporary workaround to undo, a build or rollout to finish and confirm, a question put to someone who has not answered. Recording these is not inventing work — the transcript already named them.
- Nothing is owed to the passage of time. Open-ended watching has no owner and no definite outcome — "check back in a few days", "keep an eye on it", "confirm it behaves in real use" — and does NOT keep a thread open. Nor does work the transcript puts out of scope, nor an idea raised and not adopted. Judge the state of the work, not the tone of the sign-off: agents habitually hedge when they finish ("worth a glance", "I'd flag this as open"), and an item nobody must act on does not block done however the transcript labels it. Keep anything worth remembering in "currentState" or "constraints".
- "blockedOn" is held to a higher bar than "nextStep": name a party or artifact someone could go chase — a specific review, a person, an upstream fix, a running build, an access grant. Never a duration, never "real usage" or "more data". If you cannot say who would be chased, leave it empty.
- Use empty strings, not "none" / "N/A" / "nothing".
- Write plainly and specifically. No preamble, no hedging, no restating these instructions.
- Base every claim on the transcript. Do not speculate about what the code or the user probably wants.`;

export function buildUserPrompt(args: {
  transcript: string;
  fixedStage: BriefStage | null;
}): string {
  const stageLine =
    args.fixedStage === null
      ? `Judge "stage" from the transcript.`
      : `"stage" is fixed to ${JSON.stringify(
          args.fixedStage,
        )} by the user — return exactly that value regardless of what the transcript suggests.`;

  return `${stageLine}

Thread transcript follows.

---
${args.transcript}
---

Return the JSON object now.`;
}

/**
 * Pull a JSON object out of a model reply. Small models wrap JSON in prose or
 * fences often enough that strict parsing would be the main source of failures.
 */
export function extractJson(reply: string): unknown {
  const trimmed = reply.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(trimmed);
  const candidates = [fenced?.[1], trimmed].filter(
    (value): value is string => typeof value === "string",
  );

  for (const candidate of candidates) {
    const text = candidate.trim();
    try {
      return JSON.parse(text);
    } catch {
      // Fall through to brace-slicing below.
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // Try the next candidate.
      }
    }
  }
  throw new Error("model reply contained no JSON object");
}

const EMPTY_SYNONYMS = new Set([
  "",
  "none",
  "n/a",
  "na",
  "nothing",
  "unknown",
  "not applicable",
  "no next step",
  "-",
]);

/** The model is told to use empty strings; this catches it when it doesn't. */
function normalizeField(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return EMPTY_SYNONYMS.has(trimmed.toLowerCase()) ? "" : trimmed;
}

/**
 * The actor, or `undefined` when there is no usable one: the model omitted it,
 * sent a word we do not recognise, or named an actor for a next step that does
 * not exist.
 *
 * Undefined is a first-class value rather than a failure — every brief written
 * before this field existed has none either — so an unrecognised actor drops
 * back to the actor-free derivation instead of costing the whole brief.
 */
function normalizeActor(
  value: unknown,
  nextStep: string,
): NextStepActor | undefined {
  if (nextStep === "" || typeof value !== "string") return undefined;
  const parsed = nextStepActorSchema.safeParse(value.trim().toLowerCase());
  return parsed.success ? parsed.data : undefined;
}

const stripTrailingPunctuation = (text: string) =>
  text.replace(/[.,;:]+$/u, "").trim();

/**
 * A title the plugin is willing to put on a thread, or `undefined` when the
 * model gave nothing usable.
 *
 * Stricter than the prose fields because this one is written back into bb: a
 * title is the thread's name everywhere — sidebar, header, command palette,
 * `bb thread list` — and it replaces something the reader may have learned to
 * recognise, so a malformed one costs more than a malformed `constraints`.
 *
 * The cleanup is the small set of things models reliably do to a field asked
 * for as a name: wrap it in quotes, end it with a period, or write a sentence
 * where a label was wanted. Over-length is truncated at a word boundary rather
 * than rejected — a good name with a trailing clause is still a good name.
 */
export function normalizeTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/\s+/gu, " ").trim();
  // Punctuation is stripped on both sides of the unquote because models put a
  // trailing period on either side of the closing quote: `"A name".` needs the
  // first pass to expose the quotes, `"A name."` needs the second.
  const bare = stripTrailingPunctuation(collapsed);
  const unquoted = /^(["'`])(.+)\1$/u.exec(bare)?.[2]?.trim() ?? bare;
  const trimmed = stripTrailingPunctuation(unquoted);
  if (trimmed === "" || EMPTY_SYNONYMS.has(trimmed.toLowerCase())) {
    return undefined;
  }
  if (trimmed.length <= MAX_TITLE_LENGTH) return trimmed;

  const cut = trimmed.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  // Fall back to the hard cut for a single word longer than the cap, which is
  // some identifier the reader would rather see truncated than dropped.
  const clamped = stripTrailingPunctuation(lastSpace > 0 ? cut.slice(0, lastSpace) : cut);
  return clamped === "" ? undefined : clamped;
}

export function parseSummary(
  reply: string,
  fixedStage: BriefStage | null,
): SummaryResult {
  const raw = extractJson(reply);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("model reply was not a JSON object");
  }
  const record = raw as Record<string, unknown>;

  const rawStage = typeof record.stage === "string" ? record.stage.trim() : "";
  const stage: BriefStage =
    fixedStage ??
    (BRIEF_STAGES.includes(rawStage as BriefStage)
      ? (rawStage as BriefStage)
      : // An unrecognized stage is not worth failing the whole brief over;
        // implementation is the safest neutral guess.
        "implementation");

  const nextStep = normalizeField(record.nextStep);

  return summaryResultSchema.parse({
    title: normalizeTitle(record.title),
    goal: normalizeField(record.goal),
    currentState: normalizeField(record.currentState),
    nextStep,
    nextStepActor: normalizeActor(record.nextStepActor, nextStep),
    blockedOn: normalizeField(record.blockedOn),
    constraints: normalizeField(record.constraints),
    stage,
  });
}

export interface CompletionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  jsonMode: boolean;
}

/**
 * Accept either the API root or the full chat-completions endpoint.
 *
 * Providers document the full URL — Fireworks publishes
 * `https://api.fireworks.ai/inference/v1/chat/completions`, OpenAI the same
 * shape — so pasting that into a setting labelled "base URL" is the natural
 * mistake, and appending blindly produced
 * `/v1/chat/completions/chat/completions` and a 404. Trailing slashes are the
 * other common way to mistype it.
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "");
  return /\/chat\/completions$/u.test(trimmed)
    ? trimmed
    : `${trimmed}/chat/completions`;
}

export async function requestSummary(
  config: CompletionConfig,
  userPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(chatCompletionsUrl(config.baseUrl), {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      ...(config.jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `summarizer HTTP ${response.status}${
        detail === "" ? "" : `: ${detail.slice(0, 400)}`
      }`,
    );
  }

  const body = (await response.json()) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("summarizer returned an empty reply");
  }
  return content;
}
