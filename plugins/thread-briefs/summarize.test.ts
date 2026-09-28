import { describe, expect, it } from "vitest";
import {
  buildUserPrompt,
  chatCompletionsUrl,
  extractJson,
  normalizeTitle,
  parseSummary,
} from "./summarize.js";
import { MAX_TITLE_LENGTH } from "./contract.js";
import {
  endsWithQuestion,
  renderTranscript,
  selectOutline,
  type OutlineItem,
} from "./transcript.js";

const reply = (fields: Record<string, unknown>) => JSON.stringify(fields);

const full = {
  goal: "Ship thread briefs",
  currentState: "Server written",
  nextStep: "Run the tests",
  blockedOn: "",
  constraints: "",
  stage: "implementation",
};

describe("extractJson", () => {
  it("parses a bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses a fenced object", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("parses an object wrapped in prose", () => {
    expect(extractJson('Sure! {"a":1} Hope that helps.')).toEqual({ a: 1 });
  });

  it("throws when there is no object", () => {
    expect(() => extractJson("I cannot help with that.")).toThrow(/no JSON object/u);
  });
});

describe("parseSummary", () => {
  it("returns the five fields and the stage", () => {
    expect(parseSummary(reply(full), null)).toEqual(full);
  });

  it("treats 'none' and friends as empty, so status derivation stays right", () => {
    const parsed = parseSummary(
      reply({ ...full, nextStep: "N/A", blockedOn: "None", constraints: "-" }),
      null,
    );
    expect(parsed.nextStep).toBe("");
    expect(parsed.blockedOn).toBe("");
    expect(parsed.constraints).toBe("");
  });

  it("falls back to implementation for an unrecognized stage", () => {
    expect(parseSummary(reply({ ...full, stage: "vibes" }), null).stage).toBe(
      "implementation",
    );
  });

  it("forces the user's stage over the model's", () => {
    expect(parseSummary(reply({ ...full, stage: "discovery" }), "review").stage).toBe(
      "review",
    );
  });

  it("fills in missing fields rather than failing the brief", () => {
    const parsed = parseSummary(reply({ goal: "Just this" }), null);
    expect(parsed.goal).toBe("Just this");
    expect(parsed.currentState).toBe("");
    expect(parsed.nextStep).toBe("");
  });

  it("keeps a recognised actor, case and spacing aside", () => {
    expect(
      parseSummary(reply({ ...full, nextStepActor: "  Other " }), null)
        .nextStepActor,
    ).toBe("other");
    expect(
      parseSummary(reply({ ...full, nextStepActor: "me" }), null).nextStepActor,
    ).toBe("me");
  });

  it("drops an actor it does not recognise rather than failing the brief", () => {
    // An unknown actor must fall back to the actor-free derivation, not cost
    // the whole summary — the same bar as an unrecognised stage.
    const parsed = parseSummary(reply({ ...full, nextStepActor: "dylan" }), null);
    expect(parsed.nextStepActor).toBeUndefined();
    expect(parsed.goal).toBe(full.goal);
  });

  it("drops an actor named for a next step that does not exist", () => {
    expect(
      parseSummary(
        reply({ ...full, nextStep: "", nextStepActor: "agent" }),
        null,
      ).nextStepActor,
    ).toBeUndefined();
  });

  it("leaves the actor absent when the model omits it", () => {
    expect(parseSummary(reply(full), null).nextStepActor).toBeUndefined();
  });
});

describe("chatCompletionsUrl", () => {
  it("appends the path to an API root", () => {
    expect(chatCompletionsUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("tolerates a trailing slash", () => {
    expect(chatCompletionsUrl("https://api.openai.com/v1/")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("tolerates surrounding whitespace", () => {
    expect(chatCompletionsUrl("  https://x.test/v1  ")).toBe(
      "https://x.test/v1/chat/completions",
    );
  });

  // Providers document the full endpoint, so it gets pasted in as the base URL.
  // Appending blindly produced /chat/completions/chat/completions and a 404.
  it("leaves a full Fireworks endpoint alone", () => {
    expect(
      chatCompletionsUrl("https://api.fireworks.ai/inference/v1/chat/completions"),
    ).toBe("https://api.fireworks.ai/inference/v1/chat/completions");
  });

  it("accepts the Fireworks API root too", () => {
    expect(chatCompletionsUrl("https://api.fireworks.ai/inference/v1")).toBe(
      "https://api.fireworks.ai/inference/v1/chat/completions",
    );
  });

  it("leaves a full endpoint with a trailing slash alone", () => {
    expect(chatCompletionsUrl("https://x.test/v1/chat/completions/")).toBe(
      "https://x.test/v1/chat/completions",
    );
  });
});

describe("buildUserPrompt", () => {
  it("tells the model to judge the stage when there is no override", () => {
    expect(buildUserPrompt({ transcript: "t", fixedStage: null })).toContain(
      "Judge \"stage\"",
    );
  });

  it("pins the stage when the user set one", () => {
    const prompt = buildUserPrompt({ transcript: "t", fixedStage: "review" });
    expect(prompt).toContain('"stage" is fixed to "review"');
  });
});

describe("endsWithQuestion", () => {
  it("detects a trailing question", () => {
    expect(endsWithQuestion("Which approach do you want?")).toBe(true);
  });

  it("looks past trailing markdown noise", () => {
    expect(endsWithQuestion("Should I proceed?**\n")).toBe(true);
  });

  it("is false for a statement", () => {
    expect(endsWithQuestion("Done — tests pass.")).toBe(false);
  });

  it("is false for no output at all", () => {
    expect(endsWithQuestion(null)).toBe(false);
  });
});

describe("selectOutline", () => {
  const item = (n: number): OutlineItem => ({
    role: n % 2 === 0 ? "user" : "assistant",
    preview: `message ${n}`,
  });

  it("keeps a short outline whole", () => {
    const outline = Array.from({ length: 10 }, (_, n) => item(n));
    expect(selectOutline(outline)).toEqual({ items: outline, elided: 0 });
  });

  it("keeps the head and tail of a long outline and elides the middle", () => {
    const outline = Array.from({ length: 100 }, (_, n) => item(n));
    const { items, elided } = selectOutline(outline);
    expect(elided).toBe(70);
    expect(items).toHaveLength(30);
    // The opening states the goal; the tail states the current position.
    expect(items[0]?.preview).toBe("message 0");
    expect(items.at(-1)?.preview).toBe("message 99");
  });
});

describe("renderTranscript", () => {
  it("includes the previous brief so the summarizer updates rather than restarts", () => {
    const text = renderTranscript({
      title: "Thread briefs",
      outline: [{ role: "user", preview: "Build it" }],
      lastAssistantText: "Done.",
      previousBrief: {
        goal: "Ship briefs",
        currentState: "half done",
        nextStep: "finish",
        blockedOn: "",
        constraints: "kv rows cap at 256KB",
      },
    });
    expect(text).toContain("Previous brief");
    expect(text).toContain("kv rows cap at 256KB");
    expect(text).toContain("blockedOn: (empty)");
    expect(text).toContain("User: Build it");
  });

  it("marks where the middle was elided", () => {
    const outline = Array.from({ length: 100 }, (_, n) => ({
      role: "user" as const,
      preview: `m${n}`,
    }));
    const text = renderTranscript({
      title: null,
      outline,
      lastAssistantText: null,
      previousBrief: null,
    });
    expect(text).toContain("earlier messages elided");
    expect(text).toContain("(untitled)");
  });
});

describe("normalizeTitle", () => {
  it("keeps a well-formed name as it is", () => {
    expect(normalizeTitle("Sidebar grouping by brief status")).toBe(
      "Sidebar grouping by brief status",
    );
  });

  it("strips the wrapping quotes and trailing punctuation models add", () => {
    expect(normalizeTitle('"Kploy image tracking".')).toBe("Kploy image tracking");
    expect(normalizeTitle("`Machine pod memory limits`")).toBe(
      "Machine pod memory limits",
    );
  });

  it("collapses the whitespace of a wrapped reply", () => {
    expect(normalizeTitle("  Thread brief\n  titles  ")).toBe("Thread brief titles");
  });

  it("truncates an over-long name at a word boundary", () => {
    const title = normalizeTitle(
      "Adding a summarizer-chosen short name and renaming bb threads to match it",
    );
    expect(title).toBe("Adding a summarizer-chosen short name and");
    expect(title!.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
  });

  it("hard-cuts a single word longer than the cap", () => {
    // An identifier with no space to break on is better truncated than dropped.
    const title = normalizeTitle("a".repeat(80));
    expect(title).toBe("a".repeat(MAX_TITLE_LENGTH));
  });

  it("rejects a non-answer rather than putting it on a thread", () => {
    expect(normalizeTitle("")).toBeUndefined();
    expect(normalizeTitle("   ")).toBeUndefined();
    expect(normalizeTitle("N/A")).toBeUndefined();
    expect(normalizeTitle("unknown")).toBeUndefined();
    expect(normalizeTitle(null)).toBeUndefined();
    expect(normalizeTitle(42)).toBeUndefined();
  });
});

describe("parseSummary titles", () => {
  it("carries a usable title through", () => {
    expect(parseSummary(reply({ ...full, title: "Thread brief titles" }), null).title).toBe(
      "Thread brief titles",
    );
  });

  it("leaves the title absent when the model omitted it", () => {
    // Absent, not empty: the brief is still good and the thread keeps its name.
    expect(parseSummary(reply(full), null).title).toBeUndefined();
  });

  it("does not fail the whole brief over a bad title", () => {
    const summary = parseSummary(reply({ ...full, title: 12 }), null);
    expect(summary.title).toBeUndefined();
    expect(summary.goal).toBe("Ship thread briefs");
  });
});
