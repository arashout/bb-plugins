---
name: multi-repo
description: Work in a bb multi-repo workspace — a thread directory holding one git clone per repo in the project, plus the project's own .bb repo. Use when the working directory is not itself a git repo but contains several repos side by side, when a task spans more than one repo, when you need to add a repo to the workspace mid-thread, or when you want to record durable cross-repo knowledge.
---

# Multi-repo workspaces

Your working directory is a **plain directory**, not a git repo. It holds one
clone per repo in the project, plus `.bb`, the project's own repo.

```
<workspace>/
  bb-dylan/     a clone, origin = its real remote
  bb-plugins/   a clone, origin = its real remote
  .bb/          the project definition: repos.json, AGENTS.md, skills/
```

## Rules that follow from that shape

- **Run git inside a repo directory, never at the workspace root.** The root is
  not a repo, and it must not become one.
- **Never create a `.git` directory at the root.** bb watches for it and would
  switch the thread into single-repo git mode mid-session.
- Every work repo is on the **same branch**, so pull requests across repos
  correlate by head ref. Push and open PRs per repo as normal —
  each repo's `origin` is its real remote.
- Each repo's changes are measured against its own base branch. There is no
  single base branch for the workspace.

## The generated layout block

A block near the top of your instructions lists each repo's directory, branch
and absolute path. It is **correct as of thread start and never updates
mid-thread** — a live session keeps the instructions it was built with. If you
add a repo during the thread, use the tool's own result for its location, not
that block.

## Tools

| Tool | Use it when |
|---|---|
| `workspace_list_repos` | You need a repo's absolute path or branch and the layout block is not enough. |
| `workspace_add_repo` | The work genuinely spans another repo. Adds it to the project's shared `repos.json` **and** clones it into this live workspace. |
| `workspace_remove_repo` | A repo no longer belongs in the project's set. Leaves existing checkouts alone. |
| `workspace_publish_guidance` | You have committed something in `.bb` and want it back in the project. |

`workspace_add_repo` edits `repos.json`, which every future thread in this
project reads. Use it for real cross-repo work, not to fetch something for a
one-off look — for that, clone into a temporary directory.

## `.bb` — where durable knowledge goes

`.bb/` is versioned and shared by every thread in the project. It is the right
place for anything that will still be true next week:

- `AGENTS.md` — which repo depends on which, what has to be rebuilt or
  redeployed when a given repo changes, what belongs in which repo.
- `skills/` — project skills, read natively by bb.
- `repos.json` — the repo set. Prefer `workspace_add_repo` over editing it.

It is the **wrong** place for anything specific to one thread.

### Publishing changes to `.bb`

The canonical `.bb` checkout lives outside your sandbox, so `git push` from
`.bb` will not reach it. Instead:

1. Commit inside `<workspace>/.bb` as normal.
2. Call `workspace_publish_guidance`.

That lands your commits on a `guidance-<thread>` branch in the canonical
checkout, for a person to review and merge.

## Missing repos

If a repo in the set failed to clone, the layout block says so by name and the
thread still runs with the rest. Do not try to re-clone it by hand into the
workspace — report what is missing, and suggest the Repos panel or
`bb repos list`.

## Command line

- `bb repos list` — the project's repo set and each one's object-cache state.
- `bb repos status` — this thread's repos: branch, ahead/behind, working tree.
- `bb repos add <url> [--dir <name>] [--branch <name>]` — add to the set
  without cloning into this workspace (use `workspace_add_repo` for that).
- `bb repos remove <dir>`.
