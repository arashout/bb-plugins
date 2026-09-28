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

## Install

```sh
bb plugin install git:https://github.com/bitcomplete/bb-plugins.git@main --plugin thread-briefs
bb plugin config thread-briefs set apiKey <key>
```

The summarizer talks to any OpenAI-compatible `/chat/completions` endpoint. See
[`skills/thread-briefs/SKILL.md`](skills/thread-briefs/SKILL.md) for every
setting, the regeneration triggers, and how to diagnose it.

## Where briefs show up

**Sidebar row** — a single glyph for the three statuses that are news:
waiting-on-you, blocked, and done. A thread whose agent is running or queued
keeps bb's own indicator instead, because bb draws a plugin row status in place
of its unsent-draft pencil and displacing that everywhere would cost more than
it says. The live status is folded in per row on the client, off the sidebar view
it already holds, so `listRowSignals` needs no per-thread lookups.

**The thread title itself** — optionally, the brief's name replaces it:

```sh
bb plugin config thread-briefs set renameThreads true
```

bb names a thread once, from the opening prompt, before anyone knows what it
became — and nothing in bb ever rewrites it. The brief re-reads the whole
transcript every summary, so it has strictly more to go on. With this on the
name lands everywhere bb shows a title: sidebar, header, command palette,
`bb thread list`.

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

**Waiting on you**, **Blocked**, **Done**, then bb's own **Threads** group,
newest first inside each. Threads is last and holds every thread with no brief —
including ones created since the last sync — which is why it must not be hidden:
it is the "the summarizer hasn't reached this yet" bucket as much as a catch-all.

Two things to know. There is **no section for running threads**: `working` is
live state and never reaches a stored brief, so a thread whose agent is running
sits in the section its last brief implies and keeps bb's own running indicator —
the same live-vs-stored split as the panel. And a thread you filed in a section
of your own is left alone until it has a brief, but once it does the grouping
takes it over; turning grouping off deletes the three sections and restores the
sidebar preferences it changed, but cannot put a hand-made placement back.

**The side panel** — a **Brief** tab holding the full five fields (empty ones
are skipped), the derived status, when it was last summarized, a stage control
for the manual override, and Re-summarize. The **Brief** button in the thread
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

Briefs are **never backfilled** — activity earns a brief. A thread that has been
dormant since before the plugin started stays briefless, and the panel says so
with **Summarize now** rather than showing a spinner that would never resolve.
Work on it again and it gets a brief like any other thread. The alternative —
summarizing every existing thread — is an unbounded burst the first time a key is
configured.

## How it is built

| Concern | Mechanism |
| --- | --- |
| Trigger | `bb.events.on("thread.idle")` + a per-thread quiet-period debounce, with a `*/10 * * * *` sweep as the backstop |
| Summarizer input | `threads.conversationOutline()` head + tail with the middle elided, `threads.output()` for the last message in full, and the previous brief |
| Storage | `bb.storage.kv`, one row per thread at `brief:<threadId>` |
| Sidebar glyph | a content script's `experimental_setThreadRowStatus`, fed by an `experimental_appOverlay` that owns the rpc + realtime subscription |
| Brief UI | a `threadPanelAction` tab, opened by an `experimental_threadHeaderAction` button through `useBbNavigate().openThreadPanel` |
| Sidebar sections | `bb.sdk.threadSections` + `threads.update({sectionId})`, with `thread-list`'s own `organizationMode` / `manualSectionOrder` preferences set through `bb.sdk.plugins.callRpc` |
| Thread titles | `threads.update({title})`, gated on `planRename` comparing the thread's title against the one this plugin last wrote |

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
