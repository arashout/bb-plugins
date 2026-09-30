// "How this works": the secondary information the header used to carry, in
// one quiet panel. It is a fixed tab in BB's own right panel, so it can stay
// open beside any view. Short sections, in the order a reader asks: the
// effort deck, its piles and holds, sorting PRs into efforts, Seed from
// Linear, All PRs, the keys, then the Map and the legacy Board, and whether
// the board is healthy.
import type { ReactNode } from "react";
import type { Board, BoardMode } from "./server";
import { relativeTime } from "./workstreams";
import { TIER_WORDS } from "./threadmenu";
import { THREAD_TIERS } from "./threads";
import { runLabel } from "./runs";
import { LinearFetchAction } from "./linearfetch";
import { ROSTER_KEYS } from "./roster-view-model";
import { INVENTORY_HOW } from "./inventory-view-model";
import { ACTION } from "./deck-keys";
import { SEND_DELAY_MS } from "./deck-shared";

/** The fixed tab's stable reference: the owning nav panel, and this tab. */
export const HOW_TAB = { panelId: "board", id: "how" } as const;

export const MODE_TEXT: Record<BoardMode, { label: string; detail: string }> = {
  basic: {
    label: "Tickets only",
    detail: "Clusters group by ticket and take the latest PR title as their summary. Add a TypeSafe key for Jev grouping.",
  },
  jev: {
    label: "Jev",
    detail: "Jev picks summaries from your PR titles and assigns clusters to efforts. Add an Anthropic key and Claude Sonnet 5 also names the groups.",
  },
  "jev+claude": {
    label: "Jev + Claude",
    detail: "Jev assigns clusters; Claude names the groups. Without the Anthropic key, groups keep the names Jev selected.",
  },
};

const BOARD_KEYS: [string, string][] = [
  ["j / k", "Next / previous row"],
  ["Enter", "Open the pull request"],
  ["a", "Run the row's action (asks first)"],
  ["t", "Open the most recent thread"],
  ["n", "Start a thread (asks first)"],
  ["m", "Show it on the Map"],
  ["o", "Open the checkout"],
  ["/", "Search"],
  ["Esc", "Clear search, then selection"],
];

const MAP_KEYS: [string, string][] = [
  ["+ / −", "Zoom in / out"],
  ["0 or Esc", "Fit everything"],
  ["Backspace", "Back out one level"],
  ["Arrows", "Pan"],
  ["[ / ]", "Turn to the other face"],
  ["T", "Open the focused cluster's newest thread"],
];

/** The deck's keys that matter most, read from its one registry so they say what the keys do; ? in the deck lists every one. */
const DECK_KEYS: [string, string][] = (["next", "prev", "jump", "row-next", "row-prev", "select", "expand", "advance", "merge", "hold", "accept", "move", "seen",
  "undo", "palette", "help"] as const).map((id) => [ACTION[id].keys.join(" / "), ACTION[id].title.replace("…", "")]);

const BOTH_KEYS: [string, string][] = [
  ["v", "Next view; in Efforts and All PRs, switch between the two"],
  ["?", "Open this panel; in Efforts and All PRs, list their keys"],
];

const STATES: [string, string][] = [
  ["Fix · CI failing", "A check failed. Investigate CI hands it to an agent."],
  ["Fix · Resolve conflicts", "GitHub reports a merge conflict with the base."],
  ["Respond · Changes requested", "A reviewer requested changes. Approval is not in effect."],
  ["Waiting · Awaiting re-review", "The author pushed a newer head, resolved review threads, and posted PTAL to the reviewer. GitHub still reports changes requested; a branch may also need updating."],
  ["Respond · Approved · open threads", "Approved, with unresolved review threads on GitHub."],
  ["Respond · Approved · review note", "The approving review has written notes that may need action. Read them and decide what to do."],
  [
    "Merge · Approved · ready",
    "Approved; no unresolved review threads; every check finished and green; GitHub mergeStateStatus CLEAN (or HAS_HOOKS, or UNSTABLE for non-required checks); not stacked behind an unmerged PR.",
  ],
  ["Merge · Update branch", "Ready except the branch is behind its base."],
  ["Waiting · Waiting for review", "Nobody has decided yet. Nudge reviewers is one click away."],
  ["Waiting · Behind #N", "Stacked on an unmerged PR, which has to merge first."],
  ["Waiting · Blocked by branch rules", "Branch protection is unsatisfied; clicking merge would not help."],
  ["Waiting · Status unavailable", "A local status check or GitHub PR lookup failed. Rescan to verify this checkout; no PR action is offered."],
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border/60 py-3 first:pt-0 last:border-b-0">
      <h3 className="mb-1.5 text-[12px] font-semibold tracking-tight text-foreground">{title}</h3>
      <div className="space-y-1.5 text-[12px] leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

function Pairs({ rows, mono }: { rows: [string, string][]; mono?: boolean }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      {rows.map(([key, what]) => (
        <div key={key} className="contents">
          <dt className={mono ? "font-mono text-[11px] text-foreground" : "text-foreground"}>{key}</dt>
          <dd>{what}</dd>
        </div>
      ))}
    </dl>
  );
}

const number = (value: number) => value.toLocaleString();

export function HowThisWorks({ board, now }: { board: Board | null; now: number }) {
  const mode = board === null ? null : MODE_TEXT[board.mode];
  const coverage = board?.threadCoverage;
  const enrichment = board?.health.enrichment ?? null;
  return (
    <div className="text-[12px]">
      <Section title="The effort deck">
        <p>
          Efforts shows one card per effort. Flip with [ and ] (or ← and →), or press 1–9. A card shows the
          effort&apos;s status, next steps, what&apos;s blocked, Linear, people, threads, and recent activity. Its
          open PRs sit below it in sections by the move each needs, with one button per section.
        </p>
        <p>
          Color marks a move that&apos;s yours, and Needs you counts those moves; gray waits on others. A blue dot marks a
          change since you looked, and rows stay in place until you mark the view seen: a row a read moved says what
          changed and links to where it goes, and one that merged or closed stays as a one-line ghost. ↻ on a row reads
          it from GitHub again and spins until the row updates, and what changed flashes.
        </p>
        <p>
          Every GitHub write lists each PR in a confirm, then waits {Math.round(SEND_DELAY_MS / 1_000)} s with Undo.
          Advance runs a card&apos;s safe next steps: nudge, request a review, and mark ready. A row with one of those
          steps has its own Advance, and a advances the focused row, else the card; the hint bar says which. Review notes
          are confirmed one PR at a time, never by Advance. Merges run only from the fresh merge preview, on a click or ⌘↵.
        </p>
      </Section>

      <Section title="Piles and holds">
        <p>
          The strip is the active pile, with On hold and Done at its right. Hold moves an effort to On hold with an
          optional reason, and its PRs stop counting until you resume it. Complete moves it to Done, and Reopen puts it
          back at the end of the pile.
        </p>
        <p>
          To pause one PR, choose Hold PR in its details. A held PR is listed in its card&apos;s Held section, with its reason
          and how long it&apos;s been held; the Held chip in the card&apos;s header, or ⇧H, goes there. No batch or Advance
          touches it until you release it. Release, on its row or for the whole section, lists each PR first and waits
          with Undo like any write. One-offs collects PRs that merge on their own, and it stays on the active pile. To move a
          PR there from an effort, choose Move to One-offs in its details or the selection bar; Undo puts it back. Each
          effort&apos;s Notes tile keeps Markdown for flags, experiments, and the rest: ⇧N edits it in place and ⌘↵ saves.
        </p>
      </Section>

      <Section title="Sorting PRs into efforts">
        <p>
          Every open PR and thread is on a card, or with its done effort on the Done pile. A PR that no effort owns is on
          its repository&apos;s service card, such as folio · service, after the efforts in the strip. A service card works
          like an effort&apos;s card, and its PRs count in Needs you. A thread goes with the PRs it works on, or with its
          own checkout. Threads with no effort or single repository, such as ones that only ran in a shared clone, are on
          Loose threads, the last card.
        </p>
        <p>
          Suggestions above a service card&apos;s rows show where each group of its PRs could go, with its strength (strong,
          moderate, or weak) and the signals behind it: a shared ticket, Linear project, stack, linked thread, board group,
          or code area. A ticket prefix only adds weight to a stronger signal. A lone PR whose ticket nothing else carries
          is offered as a weak one-off.
        </p>
        <p>
          Nothing moves until you press a group&apos;s button, and Undo takes it back. A weak group asks again first. You
          can also move PRs to any effort, start a new effort from a selection, or mark PRs as one-offs. Promote to effort
          makes an effort of all the card&apos;s PRs in one confirm.
        </p>
        <p>
          A standing rule places new PRs on every read by ticket prefix, branch, repository, Linear project, or stack.
          Standing rules in ⌘K lists and removes them from any card. Removing a rule leaves the PRs it placed.
        </p>
      </Section>

      <Section title="Seed from Linear">
        <p>
          Seed from Linear, on a service card, proposes one effort per Linear project that has tickets on your open
          PRs. Each takes the project&apos;s name and description, and flags an effort that already matches. Check the ones
          to create. Each takes only PRs that no effort owns, never syncs with Linear after, and Undo takes it back. It
          needs a Linear API key in settings.
        </p>
      </Section>

      <Section title="All PRs">
        <p>{INVENTORY_HOW.intro}</p>
        <Pairs rows={INVENTORY_HOW.rows} />
      </Section>

      <Section title="Keys">
        <p className="text-foreground">Efforts and All PRs</p>
        <p>The same keys do the same thing in both. ? lists every key, and ⌘K lists every action.</p>
        <Pairs rows={DECK_KEYS} mono />
        <p className="pt-1 text-foreground">Map</p>
        <Pairs rows={MAP_KEYS} mono />
        <p className="pt-1 text-foreground">Roster</p>
        <Pairs rows={ROSTER_KEYS} mono />
        <p className="pt-1 text-foreground">Legacy Board</p>
        <p className="text-muted-foreground">Search accepts ticket IDs, titles, repos, workstreams, and PR numbers such as 318, #318, or quill #318.</p>
        <Pairs rows={BOARD_KEYS} mono />
        <p className="pt-1 text-foreground">All views</p>
        <Pairs rows={BOTH_KEYS} mono />
      </Section>

      <Section title="How the Map groups checkouts">
        <p>
          Checkouts with the same ticket form a cluster. Related clusters can form efforts, programs, and domains;
          levels that add no useful grouping collapse. Code seeds groups from changed code areas, shared words,
          Linear parents or projects, and linked threads. Two signals must agree, except that a Linear link needs
          only one other signal. Sharing a repository alone does not group tickets.
        </p>
        <p>
          Jev assigns groups with a confidence score; low scores land in Unsorted. Claude names groups and flags
          mixed ones. Code computes counts and rollups. Tickets with no related cluster go into team containers
          such as &ldquo;ABC &middot; 14 one-offs&rdquo;. Containers do not imply that their tickets are related.
        </p>
        {mode === null ? null : (
          <p>
            <span className="text-foreground">Grouping: {mode.label}.</span> {mode.detail}
          </p>
        )}
      </Section>

      <Section title="Legacy Board states">
        <p>
          Efforts groups all tracked checkouts by effort, with open PRs without a scanned checkout under
          No effort assigned. PR backlog groups your open PRs by next action in organizations represented
          by scanned projects: Ready to merge, Approved · next steps, Fix or respond, Waiting for review or
          another PR, Drafts and work in progress, and Status to verify.
          Remote PRs can use direct GitHub actions, but agent repairs need a scanned checkout.
          Merged and release-tagged rows remain under their effort in collapsed sections.
          &ldquo;In release tag&rdquo; means the merge commit appears in a local release tag;
          it does not verify a production deployment.
        </p>
        <p>
          Approval records a reviewer decision. Ready to merge also requires clear checks, no unresolved
          review threads, an acceptable branch and merge state, and no unmerged PR below it in a stack.
          Choose an effort to preview its next agent action. Preview only does not start an agent;
          Run automatically starts at most one repair agent at a time.
        </p>
        <p>
          Manual review and conflict repairs inspect the live PR and base, make focused fixes, test,
          push code changes, reply with the head SHA, and re-read merge gates. They ask for another
          look only when changes are still requested and never merge.
        </p>
        <p>Archive idle leaf threads from their menu. Archived threads shows history and lets you undo an archive.</p>
        <Pairs rows={STATES} />
      </Section>

      <Section title="Map marks">
        <Pairs
          rows={[
            ["Pause glyph", "Stuck: in progress or waiting, with no commits in a month or more."],
            ["Dashed rim", "Mixed grouping: Claude thought what is inside looked unrelated (Theme face)."],
            ["Small dot", "An agent thread works here; it pulses while running. Hover or click it for the list."],
          ]}
        />
      </Section>

      <Section title="Health">
        {board === null ? (
          <p>Loading…</p>
        ) : (
          <>
            <Pairs
              rows={[
                ["Last scan", board.lastScanAt === null ? "never" : new Date(board.lastScanAt).toLocaleString()],
                ["Refresh", `every ${board.health.refreshMinutes} min`],
                [
                  "Threads linked",
                  coverage === undefined
                    ? "—"
                    : `${coverage.linked} of ${coverage.threads}, to ${coverage.clustersWithThread} clusters`,
                ],
                ...THREAD_TIERS.map((tier): [string, string] => [`· ${TIER_WORDS[tier]}`, String(coverage?.byTier[tier] ?? 0)]),
                [
                  "Last enrichment",
                  enrichment === null
                    ? "not recorded yet"
                    : `${enrichment.calls} model ${enrichment.calls === 1 ? "call" : "calls"}, ${number(enrichment.inputTokens)} in / ${number(enrichment.outputTokens)} out tokens, ${relativeTime(enrichment.at, now)}`,
                ],
              ]}
            />
            <p>Git ref changes and idle thread transitions can trigger targeted refreshes. The configured interval and manual Refresh also update the board; Workstreams does not use GitHub webhooks.</p>
            <p className="pt-1 text-foreground">Recent runs</p>
            {board.runs.length === 0 ? (
              <p>No row actions in the last day.</p>
            ) : (
              <ul className="space-y-0.5">
                {board.runs.slice(0, 10).map((run) => (
                  <li key={run.id} className="flex min-w-0 gap-2">
                    <span className="w-24 shrink-0 truncate text-foreground" title={run.path}>
                      {run.path.split("/").filter(Boolean).pop() ?? run.path}
                    </span>
                    <span className="min-w-0 truncate" title={runLabel(run, now)}>
                      {runLabel(run, now)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {board.warnings.length === 0 ? null : (
              <ul className="list-disc space-y-1 pl-4 pt-1">
                {board.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </Section>

      <Section title="Linear details">
        <p>
          Add one or more Linear API keys in settings and each ticket is looked up with the key whose workspace owns
          its team prefix. For tickets no key covers, an agent in the project that holds your checkouts can look them
          up with that project's own Linear tools. It runs only when you ask.
        </p>
        <LinearFetchAction />
      </Section>

      <Section title="Data and services">
        <p>
          Board facts and caches stay in BB&apos;s local plugin storage. Workstreams uses your authenticated gh to
          read GitHub pull requests and run actions you confirm. A configured Linear key sends ticket identifiers
          to Linear and retrieves issue details.
        </p>
        <p>
          With model keys, Jev receives ticket keys, repository names, PR titles, and available Linear context to
          select summaries and groups. Anthropic receives group members, summaries, repository names, and available
          Linear or linked-thread context to name groups. Unchanged semantic inputs reuse cached decisions.
        </p>
      </Section>

      <Section title="Settings">
        <p>
          Scan roots, ticket pattern, API keys, merge method and branch deletion live on this plugin's page under{" "}
          <span className="text-foreground">Plugins → Workstreams</span>, or run{" "}
          <span className="font-mono text-[11px] text-foreground">bb plugin config workstreams</span>.
        </p>
      </Section>
    </div>
  );
}
