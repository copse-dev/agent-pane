---
title: Permission tiers and auto-approval
description: Which command shapes skip the approval dialog, and when they still ask.
---

# Permission tiers and auto-approval

Settings → Permissions → Shell commands has two stacked controls:

1. **Run commands without asking when they stay inside the project folder** —
   auto-run for sandbox-contained work.
2. **Also run recognised low-risk commands without asking** — a dropdown of
   _shapes_, not a model judgement.

The dropdown is a fixed allow-list. Anything it does not recognise still asks,
including `npx`, `npm test`, installs, force-push, `$(…)`, and a `git fetch`
that names a URL instead of a configured remote.

## Levels

| Level                          | What it may skip asking for                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Off                            | Nothing extra. Every external command still asks.                                                                                                           |
| Reads (default)                | Local reads (`ls`, `grep`, `git status` / `log` / `diff`) and network _reads_ against a remote already in `.git/config` (`git fetch origin`, `gh pr view`). |
| Reads + local commits          | Also `git add`, `git commit`, `git checkout -b`, `git stash`. These run repository git hooks.                                                               |
| Reads + local commits + pushes | Also `git push` (no force) and `gh pr create` against this project’s repo.                                                                                  |

A URL never qualifies. The remote must be a _name_ this checkout already has.

## When the dropdown does nothing

All of these still ask, even at the highest level:

- the workspace is not trusted;
- auto-run (the checkbox above the dropdown) is off;
- there is no project sandbox — Windows, or a sandbox that failed to start —
  **for write-level shapes**. Write tiers are capped at Reads without
  containment, because they run git hooks.
- the command is not on the allow-list.

On current `main`, a recognised **read**-tier shape can still skip the prompt
without a sandbox. [#1763](https://github.com/copse-dev/agent-pane/pull/1763)
closes that: after it lands, every recognised shape asks when there is no
sandbox. That is the public bar.

**You should see** `git fetch origin` and `git status` run without a dialog in
a trusted macOS or Linux project with the default Reads level and a live
sandbox. `git push` still asks until you raise the level. `curl` and `npm
install` always ask.

## Trusted commands

The trusted-command list (for example `xcodebuild`) is a different grant: you
named a binary that cannot run inside the sandbox. It is not a shape, and it
is not auto-approval. Prefer the dropdown for everyday git/`gh`; use the list
for host tools you actually typed.
