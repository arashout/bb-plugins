import { describe, expect, it } from "vitest";
import {
  buildUserPrompt,
  chatCompletionsUrl,
  clampProse,
  extractJson,
  normalizeRefresher,
  normalizeTitle,
  parseSummary,
  normalizeFinished,
  reconcileNextStep,
  reconcileStage,
  SYSTEM_PROMPT,
} from "./summarize.js";
import { MAX_REFRESHER_LENGTH, MAX_TITLE_LENGTH } from "./contract.js";
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
    // `refresher` comes back null rather than absent: a model that ignored the
    // two prose keys still wrote a usable brief, and the only consequence is a
    // thread that never shows a re-entry card.
    expect(parseSummary(reply(full), null)).toEqual({ ...full, refresher: null });
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

  it("says nothing about a status when none is pinned", () => {
    const prompt = buildUserPrompt({ transcript: "t", fixedStage: null });
    expect(prompt).not.toContain("refresherShort");
  });

  it("tells the refreshers about a pinned status, and only them", () => {
    // The pin sits in front of the derivation rather than editing the fields it
    // reads: a `nextStep` blanked to satisfy a pin would be fed back as the
    // previous brief and written into storage. So the prompt scopes the pin to
    // the two prose fields and says the rest still describes the work.
    const prompt = buildUserPrompt({
      transcript: "t",
      fixedStage: null,
      pinnedStatus: "waiting-on-other",
    });
    expect(prompt).toContain('For "refresherShort" and "refresherFull" only');
    expect(prompt).toContain("must not tell them to carry on");
    expect(prompt).toContain("The other fields still describe the work");
  });

  it("tells them not to hand out a next step on a thread pinned done", () => {
    const prompt = buildUserPrompt({
      transcript: "t",
      fixedStage: null,
      pinnedStatus: "done",
    });
    expect(prompt).toContain("must not hand out a next action");
  });
});

describe("clampProse", () => {
  it("leaves prose inside the budget alone, whitespace collapsed", () => {
    expect(clampProse("You were\n  mid-reconcile.", 100)).toBe(
      "You were mid-reconcile.",
    );
  });

  it("cuts back to the last whole sentence", () => {
    // What survives has to read as sentences. A clause ending in an ellipsis is
    // the thing people skip.
    const text = "You wired the sections. The order is not pinned. Run the reconcile and check it lands where you expect.";
    expect(clampProse(text, 60)).toBe(
      "You wired the sections. The order is not pinned.",
    );
  });

  it("falls back to a word boundary for one very long sentence", () => {
    const text = `${"word ".repeat(40)}end.`;
    const clamped = clampProse(text, 50);
    expect(clamped.endsWith("…")).toBe(true);
    expect(clamped.length).toBeLessThanOrEqual(50);
  });

  it("keeps cutting when the only sentence end is right at the start", () => {
    // A boundary in the first fifth of the budget is a one-line answer to a
    // three-line question, not a clamp; taking it would throw the rest away.
    const text = `Yes. ${"word ".repeat(40)}end.`;
    expect(clampProse(text, 60).endsWith("…")).toBe(true);
  });
});

describe("normalizeRefresher", () => {
  it("keeps both variants", () => {
    expect(
      normalizeRefresher({ short: " One line. ", full: "Two lines, really." }),
    ).toEqual({ short: "One line.", full: "Two lines, really." });
  });

  it("keeps a lone variant rather than dropping the pair", () => {
    // `chooseRefresher` falls back to whichever one exists, so a model that
    // answered only the short form still reorients someone back after a week.
    expect(normalizeRefresher({ short: "One line.", full: "" })).toEqual({
      short: "One line.",
      full: "",
    });
  });

  it("returns null when the model ignored both keys", () => {
    expect(normalizeRefresher({ short: undefined, full: undefined })).toBeNull();
    expect(normalizeRefresher({ short: "none", full: "N/A" })).toBeNull();
  });

  it("clamps each variant to its own budget", () => {
    const long = `${"Sentence here. ".repeat(80)}`;
    const prose = normalizeRefresher({ short: long, full: long });
    expect(prose!.short.length).toBeLessThanOrEqual(MAX_REFRESHER_LENGTH.short);
    expect(prose!.full.length).toBeLessThanOrEqual(MAX_REFRESHER_LENGTH.full);
    expect(prose!.full.length).toBeGreaterThan(prose!.short.length);
  });
});

describe("reconcileStage", () => {
  it("promotes implementation to review when nothing is owed", () => {
    expect(reconcileStage("implementation", "")).toBe("review");
  });

  it("leaves implementation alone while a next step stands", () => {
    expect(reconcileStage("implementation", "Run the tests")).toBe("implementation");
  });

  it("never promotes a stage with no work behind it", () => {
    // A discovery or planning thread with nothing owed was dropped before any
    // work existed; calling it review would claim there is something to review.
    expect(reconcileStage("discovery", "")).toBe("discovery");
    expect(reconcileStage("planning", "")).toBe("planning");
  });

  it("leaves review where it is", () => {
    expect(reconcileStage("review", "")).toBe("review");
  });
});

describe("normalizeFinished", () => {
  it("reads a JSON boolean", () => {
    expect(normalizeFinished(true)).toBe(true);
    expect(normalizeFinished(false)).toBe(false);
  });

  it("tolerates a quoted answer, since JSON mode does not stop a model quoting one", () => {
    expect(normalizeFinished("true")).toBe(true);
    expect(normalizeFinished(" Yes ")).toBe(true);
    expect(normalizeFinished("done")).toBe(true);
    expect(normalizeFinished("false")).toBe(false);
    expect(normalizeFinished("open")).toBe(false);
  });

  it("is unknown for anything else, so an old or odd reply falls back to nextStep", () => {
    expect(normalizeFinished(undefined)).toBeUndefined();
    expect(normalizeFinished(null)).toBeUndefined();
    expect(normalizeFinished(1)).toBeUndefined();
    expect(normalizeFinished("mostly")).toBeUndefined();
  });
});

describe("reconcileNextStep", () => {
  it("lets a finished verdict clear a step the model wrote anyway", () => {
    expect(
      reconcileNextStep({ finished: true, nextStep: "Try it out", blockedOn: "" }),
    ).toBe("");
  });

  it("keeps the step while a blocker is named, whatever the verdict says", () => {
    // blockedOn is the higher bar, and a blocked thread must never read as done.
    expect(
      reconcileNextStep({
        finished: true,
        nextStep: "Merge PR #12",
        blockedOn: "PR #12 review",
      }),
    ).toBe("Merge PR #12");
  });

  it("leaves an unfinished thread's step alone", () => {
    expect(
      reconcileNextStep({ finished: false, nextStep: "Run the tests", blockedOn: "" }),
    ).toBe("Run the tests");
  });

  it("does not manufacture a step for an unfinished thread that named none", () => {
    expect(reconcileNextStep({ finished: false, nextStep: "", blockedOn: "" })).toBe("");
  });

  it("changes nothing when the model gave no verdict", () => {
    expect(
      reconcileNextStep({ finished: undefined, nextStep: "Run the tests", blockedOn: "" }),
    ).toBe("Run the tests");
  });
});

describe("parseSummary finished", () => {
  it("asks the model for the verdict before the step", () => {
    const finishedAt = SYSTEM_PROMPT.indexOf('"finished"');
    const nextStepAt = SYSTEM_PROMPT.indexOf('"nextStep"');
    expect(finishedAt).toBeGreaterThan(-1);
    expect(finishedAt).toBeLessThan(nextStepAt);
  });

  it("reads a hand-over sign-off as done, not waiting on you", () => {
    // The commonest way a finished thread stayed open: the agent built the
    // thing and signed off with "try it", and the model dutifully recorded
    // that as the next step with the user as its actor.
    const parsed = parseSummary(
      reply({
        ...full,
        finished: true,
        nextStep: "Reload the client and check the panel opens",
        nextStepActor: "me",
      }),
      null,
    );
    expect(parsed.nextStep).toBe("");
    expect(parsed.nextStepActor).toBeUndefined();
    expect(parsed.blockedOn).toBe("");
    // And the stage reconciliation sees the cleared step.
    expect(parsed.stage).toBe("review");
  });

  it("keeps a blocked thread blocked even when the model calls it finished", () => {
    const parsed = parseSummary(
      reply({
        ...full,
        finished: true,
        nextStep: "Merge once approved",
        nextStepActor: "other",
        blockedOn: "review of PR #12",
      }),
      null,
    );
    expect(parsed.nextStep).toBe("Merge once approved");
    expect(parsed.nextStepActor).toBe("other");
    expect(parsed.blockedOn).toBe("review of PR #12");
    expect(parsed.stage).toBe("implementation");
  });

  it("keeps the step of a thread the model calls unfinished", () => {
    const parsed = parseSummary(reply({ ...full, finished: false }), null);
    expect(parsed.nextStep).toBe("Run the tests");
    expect(parsed.stage).toBe("implementation");
  });

  it("behaves exactly as before when the key is missing", () => {
    expect(parseSummary(reply(full), null)).toEqual({ ...full, refresher: null });
  });

  it("does not store the verdict itself", () => {
    expect(parseSummary(reply({ ...full, finished: true }), null)).not.toHaveProperty(
      "finished",
    );
  });
});

describe("parseSummary stage reconciliation", () => {
  it("reads a completion narrative as review, not implementation", () => {
    // The bug this exists for: one call returns both keys, and an agent signing
    // off with what it built gets an empty nextStep beside an unmoved stage.
    const parsed = parseSummary(
      reply({ ...full, nextStep: "", stage: "implementation" }),
      null,
    );
    expect(parsed.stage).toBe("review");
  });

  it("promotes the fallback stage too", () => {
    // An unusable stage falls back to implementation, and a thread owing
    // nothing is better guessed as review than as mid-build.
    expect(
      parseSummary(reply({ ...full, nextStep: "", stage: "vibes" }), null).stage,
    ).toBe("review");
  });

  it("treats an empty synonym as nothing owed", () => {
    expect(
      parseSummary(reply({ ...full, nextStep: "N/A", stage: "implementation" }), null)
        .stage,
    ).toBe("review");
  });

  it("leaves a pinned stage pinned", () => {
    // The pin's promise is that it is returned whatever the transcript says.
    expect(
      parseSummary(
        reply({ ...full, nextStep: "", stage: "review" }),
        "implementation",
      ).stage,
    ).toBe("implementation");
  });
});

describe("parseSummary refreshers", () => {
  it("reads the two prose keys off the reply", () => {
    const parsed = parseSummary(
      reply({
        ...full,
        refresherShort: "You were mid-reconcile. Run the tests.",
        refresherFull: "You were mid-reconcile on the section sync. It lands, but the order is unpinned. Run the tests.",
      }),
      null,
    );
    expect(parsed.refresher).toEqual({
      short: "You were mid-reconcile. Run the tests.",
      full: "You were mid-reconcile on the section sync. It lands, but the order is unpinned. Run the tests.",
    });
  });

  it("does not fail the brief over a model that skipped them", () => {
    // Losing the five fields, the ring and the sidebar section over a missing
    // paragraph would be a bad trade in every direction.
    const parsed = parseSummary(reply(full), null);
    expect(parsed.refresher).toBeNull();
    expect(parsed.goal).toBe(full.goal);
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
