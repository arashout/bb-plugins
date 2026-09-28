---
name: thread-briefs
description: Configure or diagnose the Thread briefs plugin — the per-thread goal/state/next-step brief, its summarizer endpoint, the sidebar glyphs, the manual stage override, and renaming threads to the brief's title.
---

# Thread briefs

Keeps one short, durable brief per thread — goal, current state, next step,
blocked on, constraints — generated outside the working chat so the thread's own
context stays clean. Briefs surface as a glyph on the sidebar row and in full
behind the **Brief** control in the thread header.

## Settings

Set these with `bb plugin config thread-briefs set <key> <value>`.

| Key | Default | What it does |
| --- | --- | --- |
| `baseUrl` | `https://api.openai.com/v1` | OpenAI-compatible endpoint. Either the API root or the full `/chat/completions` URL works; trailing slashes are fine. |
| `apiKey` | _(unset, secret)_ | Bearer token for that endpoint. The plugin reports `needs-configuration` until it is set. |
| `model` | `gpt-4o-mini` | Model used for summarizing. Any small instruction-following model works. |
| `jsonMode` | `true` | Send `response_format: {type: "json_object"}`. Turn **off** for endpoints that reject it (many local servers do). |
| `quietSeconds` | `120` | How long a thread must be quiet before it is summarized. |
| `renameThreads` | `false` | `true` renames each thread to the short name its brief chose. See [Thread titles](#thread-titles). |
| `sidebarGrouping` | `off` | `status` groups the sidebar into status sections instead of by project; `off` restores it. See [Sidebar sections](#sidebar-sections). |

The key is a secret setting, so it stays on the server and is never sent to the
frontend.

Worked example, Fireworks:

```sh
bb plugin config thread-briefs set baseUrl "https://api.fireworks.ai/inference/v1"
bb plugin config thread-briefs set model "accounts/fireworks/models/glm-5p3-flash"
bb plugin config thread-briefs set apiKey "<key>"
```

A 404 naming a doubled path (`/chat/completions/chat/completions`) meant an older
build appended the path to a `baseUrl` that already ended in it. Both spellings
are accepted now.

## When a brief is regenerated

1. `thread.idle` fires at every turn boundary and starts a `quietSeconds`
   debounce for that thread. `thread.active` cancels it — a thread mid-burst is
   not summarized until the burst stops.
2. A `*/10 * * * *` sweep is the backstop for activity whose `thread.idle` never
   arrived (server restart, plugin reload, a turn that ended in `error`). It only
   enqueues threads whose stored cursor is behind the thread's own.
3. Before spending a request, the summarizer compares the thread's
   `conversationOutline().maxSeq` against `lastActivitySeen` and skips threads
   that have not actually moved.

Re-summarize is available in the header popover; it bypasses the debounce.

Hidden threads (plugin workers) and deleted threads never get briefs.

**Briefs are never backfilled — activity earns a brief.** A thread gets its
first brief from a turn happening while the plugin is running. The sweep will
only give a *briefless* thread a first brief if its last activity postdates the
current plugin load, which is activity whose `thread.idle` should have arrived
and may have been missed. A thread that has been dormant since before the plugin
started stays briefless, however old or recent, and the header popover says so
with a **Summarize now** button. Work on it again and it gets a brief like any
other thread.

This is deliberate: without the bound, every briefless thread would be
re-enqueued on every sweep forever — an unbounded burst of requests across the
whole thread list the first time a key is configured, and an endless retry for
any thread whose summary keeps failing.

So a thread reports `summarizing` only while work is genuinely debounced,
queued, or in flight; otherwise it reports `absent`, which the UI renders as an
offer rather than a spinner. A failed summary drops back to `absent`.

## Stage and status

`stage` is a semantic judgement from the transcript: discovery, planning,
implementation, review. Pick a stage by hand in the header popover to override
it; the override is anchored to the thread's activity cursor and retires itself
on the next real turn. Clicking the active manual stage clears it.

`status` is derived mechanically, so it stays correct between summaries. It has
a live half and a stored half, and the live half wins:

- the thread is `active`, `starting` or `pending` → **working**, whatever the
  brief says. A run in flight is newer information than the brief, which
  describes the last turn that finished.
- otherwise, from the stored brief:
  - `nextStep` **and** `blockedOn` both empty → **done**
  - `blockedOn` non-empty, or `nextStepActor` is `other` → **waiting-on-other**
  - otherwise → **waiting-on-me**

**done** needs both fields empty, so a blocked thread cannot read as done even
if a summary comes back without a next step. And **waiting-on-me** is the
fallback: an idle thread with work left needs a human look whether or not its
last turn ended in a question, and whether or not the actor is known.

`nextStepActor` is the one input the model judges rather than the code: "try it
and tell me if the glyph looks right" and "keep porting the call sites" are both
concrete next actions, and nothing in the prose separates them. It is **optional**
— absent means unknown, which covers both a brief written before the field
existed and one whose `nextStep` is empty — and an actor the parser does not
recognise is dropped rather than failing the brief, the same bar as an
unrecognised stage. Either way the status falls back to the rules above with the
actor clause skipped.

An actor of `agent` — an idle thread the agent could carry on by itself — has no
status of its own and currently reads **waiting-on-me**, because the nudge is
yours to give. If that bucket turns out to be common it earns its own status
then.

Briefs are not re-summarized to pick the field up: old rows gain an actor on
their next natural summary. To see how far that has spread, compare the rows
that have one against the total.

Beyond that guard, **done** is only as good as the summarizer's bar for
"finished", and the prompt sets that bar at **whether anybody owes the thread an
action** — something a person or team must do, that will not happen on its own,
and that would be dropped if the brief did not record it.

That test cuts both ways, and the prompt names both halves because each has its
own failure:

- An obligation **outside the chat** still counts, and is the one that gets
  silently dropped: a PR open for review or merge, a patch carried on a fork
  until it lands upstream, a temporary workaround to undo, a rollout to finish
  and confirm. These earn a `nextStep` and a `blockedOn`, so the thread reads
  **waiting-on-other** rather than done.
- **Nothing is owed to the passage of time.** Open-ended watching — "check back
  in a few days", "keep an eye on it", "confirm it behaves in real use" — has no
  owner and no definite outcome, so it does not keep a thread open. Neither does
  work the transcript puts out of scope, nor an idea nobody adopted.

The second half exists because the first, on its own, made `done` a function of
the agent's closing rhetoric rather than of the work. Agents habitually hedge
when they sign off — "worth a glance", "I'd flag this as open" — and a bar of
"nothing outstanding anywhere" is unfalsifiable, so any such sentence kept a
finished thread out of Done. Two threads that had both shipped and rolled out
landed in different sections purely because one agent volunteered a caveat. The
prompt now says to judge the state of the work, not the tone of the sign-off.

`blockedOn` carries a **higher** bar than `nextStep`, because it is the field
that jams the door: any non-empty value forces **waiting-on-other**, and
`renderTranscript` feeds the previous brief back into the next summary, so a
stray value is sticky. It must name a party or artifact someone could go
chase — a specific review, a person, an upstream fix, a running build, an access
grant — never a duration, "real usage", or "more data". The Blocked section is
meant to be a list of things you could go poke; if you cannot say who would be
chased, it is not blocked.

A thread whose brief disagrees with this bar is usually one written before the
bar changed: **Re-summarize** from the header popover. That re-reads the
transcript under the current prompt, but note it also feeds the old brief back
as a starting point, so a wrong `blockedOn` can survive if the transcript still
reads as though it were true.

## Thread titles

```sh
bb plugin config thread-briefs set renameThreads true
```

Off by default. On, every summary also puts the brief's `title` — a 4–6 word
name for the work — on the thread, so the sidebar, thread header, command
palette and `bb thread list` all show it.

**Why this exists.** bb generates a thread's title exactly once, from the
opening prompt, before anyone knows what the thread became; if generation fails
or the prompt is under five words it falls back to the raw first prompt clamped
to 80 characters. Nothing in bb ever rewrites it. So a title written here is
permanent, and the brief — which reads the whole transcript every summary — has
strictly more to go on than the thing that named the thread.

**It will not clobber a name you chose.** bb records no provenance for a title,
so the plugin remembers the last title it wrote (`appliedTitle` on the brief
row) and compares:

- never written one → whatever is there is bb's guess; replace it
- thread still shows the name we wrote → ours; update it
- anything else → **you renamed it. Renaming that thread stops permanently.**

The stop needs no flag: the skipped rename leaves `appliedTitle` pointing at the
old name, so the comparison keeps failing on every later summary. Rename a
thread back to exactly the name the plugin last wrote and it resumes.

The thread is re-read immediately before the write, so a rename made *during* a
summarizer call (up to 60s) is not overwritten by a name chosen before it.

Other things worth knowing:

- The previous title is fed back to the summarizer, so a settled thread's name
  stays put instead of wobbling between synonyms. A write only happens when the
  name actually changes — which matters because bb's title PATCH also dispatches
  a rename command to the thread's environment.
- Names are clamped to 48 characters at a word boundary, matching bb's own cap;
  wrapping quotes and trailing punctuation are stripped. A model answer of
  `N/A`, `none` or similar is treated as "no name" and the thread is left alone.
- The name is stored on the brief whether or not renaming is on, so turning the
  setting on later has one ready for every thread with a brief. It is applied at
  the next summary, not retroactively.
- **Turning it off does not undo anything.** bb's original title is not kept
  anywhere; the last name the plugin wrote stays. Rename by hand to change it.
- Branch names are derived at thread creation and are unaffected.

## Sidebar glyphs

bb paints a plugin row status **in place of** its own unsent-draft pencil, so
only the three states that are news get a glyph — a `working` thread keeps bb's
own running indicator:

| Status | Glyph |
| --- | --- |
| waiting-on-me | `MessageQuestion` |
| waiting-on-other | `Pause` |
| done | `CircleCheck`, success tone |

Because `working` draws nothing, the live override reads as a **suppression**: a
thread that is running shows no brief glyph, and its stored glyph comes back the
moment it goes idle. The live half is computed in the client from
`experimental_useSidebarThreads()`, which is why no row needs a server round
trip to stay current, and why `listRowSignals` does no per-thread lookups.

One consequence worth knowing: the header popover shows the **stored** status,
so a running thread whose brief says "Waiting on you" will say that in the
popover while its row shows no glyph. The row is live; the popover is the brief.

## Sidebar sections

`bb plugin config thread-briefs set sidebarGrouping status` replaces the
sidebar's project grouping with three sections, top to bottom, and then bb's own
**Threads** group:

| Section | Holds |
| --- | --- |
| Waiting on you | stored status `waiting-on-me` |
| Blocked | stored status `waiting-on-other` |
| Done | stored status `done` |
| Threads (bb's own) | every thread with **no brief** |

Threads last is the design, not an oversight. A thread with no brief is left
*unassigned* rather than filed anywhere, so that group is exactly the briefless
set — including a thread created since the last sync, which needs no sync to
appear. Hiding it would lose threads, so don't add `threads` to `hiddenGroups`.

There is **no section for running threads**. `working` is live state and never
reaches a stored brief, so a section keyed on it could not have members; a
running thread sits where its last brief puts it and keeps bb's own running
indicator. Grouping on live state would mean the server reacting per thread,
which is the cost the row glyph design already avoids.

What the sync owns, and hands back on `off`:

- the three sections — deleted on `off`, which clears their assignments
- `organizationMode` → `chronological`
- `chronologicalSort` → `updated` (newest first inside each section)
- `manualSectionOrder` → pinned, the three sections, then `threads`

Prior values are recorded before the first write and restored on `off`; a
preference bb had never been given is reset rather than guessed at, because
`thread-list` owns its own defaults. A thread **you** filed in a section of your
own is left alone while it has no brief, but once it has one the grouping takes it
over, and `off` cannot put a hand-made placement back.

Reconciles run on plugin start, after any batch of briefs is written (debounced,
so a burst is one pass), and whenever the setting changes. It is idempotent: a
thread already in the right section is not touched, and a settled sidebar costs
no preference writes.

## Diagnosing

- `bb plugin list` — service and schedule status, including the sweep's
  `last_status` / `last_error`.
- `bb plugin logs thread-briefs -n 50` — per-thread summarizer failures are
  logged as warnings and never crash the queue. Section syncs log what they
  moved, and a failed sync logs `sidebar grouping failed` rather than retrying.
- Sections exist but the sidebar still groups by project: check
  `bb thread-list prefs get organizationMode`. Something changed it back after
  the sync; the next reconcile will set it again.
- No glyphs at all, but the header popover works: the bb client predates
  `experimental_setThreadRowStatus`, which the content script feature-detects.
- Briefs stuck on "Summarizing…": check `apiKey` is set and
  `bb plugin logs thread-briefs` for HTTP errors from `baseUrl`.
- "No brief for this thread yet" on an older thread is expected, not a fault —
  briefs are never backfilled. Work the thread, or use **Summarize now**.
- A thread that stopped picking up new titles was renamed by hand at some point;
  that is the designed stop, and it is permanent. To restart it, rename the
  thread to exactly the last name the plugin gave it.
- Renames logged as `could not rename <id>` leave the brief intact and retry on
  the next summary.
