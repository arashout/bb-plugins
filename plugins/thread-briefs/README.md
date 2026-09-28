# Thread briefs

Threads in the bb sidebar are opaque — a truncated title, and re-entering one
means re-reading the transcript to remember what it was for. This plugin gives
every thread a short, durable **brief**, generated outside the working chat:

- **goal** — what the thread is actually trying to achieve
- **currentState** — what exists now, including half-done work
- **nextStep** — the single most concrete next action, or empty when nobody owes
  the thread one. An open PR, a patch carried on a fork, or a workaround still in
  place is owed; open-ended watching is not
- **nextStepActor** — who has to take it: `me`, `agent`, or `other`. The one
  judgement the status needs that the prose cannot supply, since "test it and
  tell me" and "keep going" read alike
- **blockedOn** — the party or artifact it is waiting on, when someone could go
  chase it
- **constraints** — facts learned in the thread that would break a naive re-plan
- **title** — a 4–6 word name for the work, which can optionally replace bb's
  own thread title

Plus a derived **stage** (discovery / planning / implementation / review) and
**status** (working / waiting-on-me / waiting-on-other / done) — where `working`
comes from bb's live thread state and the other three from the brief.

Either can be pinned by hand in the Brief panel, anchored to the thread's
activity cursor so the pin retires on the next real turn. The status pin is what
closes a thread whose next step was carried out somewhere the transcript cannot
see — "reload a client and confirm the panel opens" leaves nothing for a summary
to read, so the derivation would say `waiting-on-me` forever.

## Install

```sh
bb plugin install git:https://github.com/bitcomplete/bb-plugins.git@main --plugin thread-briefs
bb plugin config thread-briefs set apiKey <key>
```

The summarizer talks to any OpenAI-compatible `/chat/completions` endpoint. See
[`skills/thread-briefs/SKILL.md`](skills/thread-briefs/SKILL.md) for every
setting, the regeneration triggers, and how to diagnose it.

## Where briefs show up

**Sidebar row** — a **ring** showing the stage: one of four quarters filled per
stage reached, so `discovery` is a quarter, `implementation` is three quarters,
`review` closes the ring, and a `done` thread gets the closed ring with its
centre filled in.

The glyph draws the stage rather than the status because status is what the
sidebar's own [status grouping](#sidebar-sections) already puts in the section
header — a status glyph spends the row's one slot repeating its own heading.
Stage is orthogonal to it, and is the thing that says which of a dozen threads
waiting on you is one turn from finished. It is also ordinal, which a ring can
show and a set of unrelated glyphs cannot: four rings are read at a glance
without reading any of them, and the fill's endpoint lands on a clock position
rather than a count of marks. `done` is a status, not a fifth stage — keeping it
off the ring is what holds the ring at four readable segments.

Two consequences. `waiting-on-me` and `waiting-on-other` draw the **same** ring,
told apart by the section header or the hover label (`Implementation —
Blocked`). And a thread whose agent is running or queued keeps bb's own
indicator: bb hides a plugin row status outright while its own is `runtime`, and
where it does not — plan mode, a goal, a workflow — a ring would displace a live
glyph that says more than a stored brief can. bb also paints the status in place
of its unsent-draft pencil, so decorating a row is never free. The live status is
folded in per row on the client, off the sidebar view it already holds, so
`listRowSignals` needs no per-thread lookups.

The same rings label the stage control in the Brief panel, which is where the
vocabulary is learned: four rings in a row, each next to its name.

**The thread title itself** — optionally, the brief's name replaces it:

```sh
bb plugin config thread-briefs set renameThreads true
```

bb names a thread once, from the opening prompt, before anyone knows what it
became — and nothing in bb ever rewrites it. The brief re-reads the whole
transcript every summary, so it has strictly more to go on. With this on the
name lands everywhere bb shows a title: sidebar, header, command palette,
`bb thread list`.

Where bb ended up with no title at all, the row falls back to its raw opening
prompt, and the first brief names the thread without waiting for the first turn
to finish. A thread bb *did* name keeps that name until the turn ends and the
better-informed summary arrives.

It will not clobber a name you chose. The plugin remembers the title it last
wrote, and finding anything else on the thread means you renamed it — so that
thread is never renamed again. Nothing is stored to record the stop: the skipped
rename leaves the remembered name pointing at the old one, so the comparison
keeps failing. The thread is also re-read immediately before the write, so a
rename made during a summarizer call is not overwritten by a name chosen before
it. Turning the setting off undoes nothing — bb's original title is not kept.

**Sidebar sections** — optionally, the sidebar groups by status instead of by
project:

```sh
bb plugin config thread-briefs set sidebarGrouping status   # on
bb plugin config thread-briefs set sidebarGrouping off      # off again
```

**🙋 Waiting on you**, **⏸️ Blocked**, **✅ Done**, then bb's own **Threads**
group, newest first inside each. Threads is last and holds every thread with no
brief — including ones created since the last sync — which is why it must not be
hidden: it is the "the summarizer hasn't reached this yet" bucket as much as a
catch-all.

The emoji *is* the header glyph. bb draws a section header as plain text and has
no icon on a section, so the only way to tell the three apart at a glance is the
name itself. A section is also keyed on its name, so changing one of these names
is a **rename** of the existing section rather than a new one beside it — that is
what `formerNames` in `sections.ts` is for, and it is why renaming a section by
hand makes the next sync build its own alongside yours.

Two things to know. There is **no section for running threads**: `working` is
live state and never reaches a stored brief, so a thread whose agent is running
sits in the section its last brief implies and keeps bb's own running indicator —
the same live-vs-stored split as the panel. And a thread you filed in a section
of your own is left alone until it has a brief, but once it does the grouping
takes it over; turning grouping off deletes the three sections and restores the
sidebar preferences it changed, but cannot put a hand-made placement back.

**The side panel** — a **Brief** tab holding the full five fields (empty ones
are skipped), the derived status, when it was last summarized, status and stage
controls for the manual overrides, and Re-summarize. The **Brief** button in the thread
header opens it; so does the panel's own new-tab launcher, under Actions. It
works the same on mobile and desktop — on a compact viewport the host reveals
the panel drawer as part of the open — and nothing depends on hover.

A panel rather than a popover because reading the whole brief is a deliberate
shift out of chatting and into orienting: it wants to stay open beside the
transcript while you scroll it, and a popover closes on the first click outside
itself. The button stays because panel tabs are per-thread and per-device — a
Brief tab open on one thread is not open on the next — so without a fixed
control in the header, seeing a brief would mean walking the new-tab launcher on
every thread, which is friction landing on exactly the moment this is for.

**Above the composer** — a **re-entry refresher**: one to three sentences of
prose, in a card in the prompt stack, on a thread you have been away from.

```sh
bb plugin config thread-briefs set refresherIdleHours 8   # 0 turns it off
```

The five fields are a reference, and a reference is something you consult. This
is the thing you read without meaning to: what you were doing, how far it got,
what to do next, in the register someone would use leaning over your shoulder as
you sit back down. The two variants — a line for a thread you left this morning,
a paragraph for one you left last week — are both written at summarize time and
chosen when the thread is opened, because how much you have forgotten is a fact
about the gap, not about the thread. **No model call happens when a thread is
opened.** If the stored prose does not fit the moment, nothing is shown.

It appears only when reorienting is actually likely: the thread has been idle
past the threshold **and** you have not already dismissed that particular
activity. It never appears on a running thread, never on a thread with no brief,
and never twice for the same activity — sending a message or dismissing it
records the thread's attention cursor, and only new activity you have not seen
brings it back.

A composer banner rather than a floating overlay, because bb owns the position:
the card sits in the same prompt stack as bb's own Goal and Todo cards, which
means it structurally cannot cover the composer, cannot take a keystroke meant
for it, and follows the composer to the bottom of a phone screen for nothing.
Positioning a fixed card ourselves would put it over the transcript as asked, at
the cost of measuring a private DOM attribute and a list of viewports where it
lands on something. A surface that cannot get in the way beats one that has to
keep checking whether it has.

The prose respects both manual overrides. A pinned stage reaches the summarizer
as fixed, the same way it already does for the fields. A pinned **status** is
harder, because it can be set long after the prose was written — so each brief
records the status reading its prose was written for, pinning a status queues
the re-summary that rewrites it under the pin, and until that lands the
refresher shows nothing rather than telling you to carry on with something you
have just called blocked.

Briefs are **never backfilled** — activity earns a brief. A thread that has been
dormant since before the plugin started stays briefless, and the panel says so
with **Summarize now** rather than showing a spinner that would never resolve.
Work on it again and it gets a brief like any other thread. The alternative —
summarizing every existing thread — is an unbounded burst the first time a key is
configured.

What *does* count as activity is deliberately early: a thread that starts
running has earned a brief, before the turn it is running has finished. The
quiet period is there to stop a busy thread being re-summarized every turn, and
a thread with no brief has nothing to protect — only an empty panel, a missing
ring and no section, for as long as its first turn takes.

## How it is built

| Concern | Mechanism |
| --- | --- |
| Trigger | `bb.events.on("thread.idle")` + a per-thread quiet-period debounce, with a `*/10 * * * *` sweep as the backstop. A thread with no brief yet skips the quiet period, and is summarized from `thread.active` as well — mid-turn, so a long first turn is not spent briefless |
| Summarizer input | `threads.conversationOutline()` head + tail with the middle elided, `threads.output()` for the last message in full, and the previous brief |
| Storage | `bb.storage.kv`, one row per thread at `brief:<threadId>` |
| Sidebar glyph | a content script's `experimental_setThreadRowStatus`, fed by an `experimental_appOverlay` that owns the rpc + realtime subscription |
| Ring artwork | `app.experimental_icons.register`, one inline SVG per stage plus the done ring, since a row status takes an icon *name* and not a component |
| Brief UI | a `threadPanelAction` tab, opened by an `experimental_threadHeaderAction` button through `useBbNavigate().openThreadPanel` |
| Re-entry refresher | an `app.composer.customize({banners})` card scoped to `thread`, `chrome: "bare"`, deciding nothing itself: one `getRefresher` call on mount, `experimental_onSubmitted` for the send that retires it |
| Sidebar sections | `bb.sdk.threadSections` + `threads.update({sectionId})`, with `thread-list`'s own `organizationMode` / `manualSectionOrder` preferences set through `bb.sdk.plugins.callRpc` |
| Thread titles | `threads.update({title})`, gated on `planRename` comparing the thread's title against the one this plugin last wrote |

### Why the refresher is decided on the server, in one call

Everything the decision reads is server-side: the stored prose, the effective
status with its overrides, the thread's `latestAttentionAt`, and the dismissal
record. Splitting it would mean shipping all four to the client to recombine
them there. So the client asks once when the banner mounts and renders the
sentence it is handed — which also means the *whole* rule lives in one pure
function, `chooseRefresher`, rather than spread across a component's effects.

`latestAttentionAt` rather than `updatedAt` is load-bearing. This plugin writes
thread titles and section assignments, and both move `updatedAt` — counting our
own rename as activity would reset the idle clock on exactly the threads the
refresher exists for.

The one thing the client decides is when to stop showing it, because that is the
one input the server cannot see: a send, through
`useComposer().experimental_onSubmitted`.

### Why a content script rather than a list fork

bb exposes exactly one slot that owns thread rows,
`app.slots.experimental_threadList`, and it is *exclusive* — a plugin either
replaces the whole sidebar list or touches none of it. The per-row hooks
(`useSidebarThreadDraft`, `useSidebarThreadRowStatus`, …) are for a replacement
list to *consume*, not injection points into bb's own list. Inline row
expansion therefore means forking `plugins/thread-list` (~28k lines) and
re-merging it forever, so this plugin uses the additive surfaces bb supports
instead: a row glyph, and a header button onto a side-panel tab.

### Why `thread.idle` rather than polling

`bb.events.on("thread.idle", …)` delivers the thread DTO on every transition
into idle, which is the turn-completion signal a poll would be approximating.
Polling remains only as the 10-minute sweep, for activity whose event never
arrived — a server restart, a plugin reload, or a turn that ended in `error`
rather than idle.

### Why renaming is safe, and why it needs bookkeeping

bb's `applyGeneratedThreadTitle` refuses to write over an existing title, and it
is the only automatic writer, so a title this plugin writes will not be
overwritten by bb. The risk runs the other way: a `threads` row carries no
provenance for its title — there is no column saying whether it came from bb's
guess, a rename, or us — so "is this name mine to change?" can only be answered
from memory. `appliedTitle` on the brief row is that memory, and `planRename` is
the whole rule, kept pure and tested away from the effect.

### Why sections rather than a grouping mode

Grouping the sidebar by status needs no fork either, because a section is core bb
state: `thread-list` renders whatever sections exist when its `organizationMode`
is `chronological`, so assigning threads to sections *is* the grouping. The sync
reconciles in one full pass — one `threads.list` plus one kv scan — rather than
per changed brief: it costs less than a `threads.get` per thread once a batch is
more than a handful, it is self-healing after a write we missed, and startup and
steady state run the same code. The debounce is what turns a burst of brief
writes into a single pass, so the preference writes happen once per batch.

Section display order is creation order as far as bb is concerned — a
`ThreadSection` has no position field — so the sync both creates the sections in
display order and pins that order in `manualSectionOrder`.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```
