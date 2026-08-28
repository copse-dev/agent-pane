---
title: Project instructions
description: Give Copse global, project-wide, or directory-scoped guidance with AGENTS.md files.
---

# Project instructions

Instruction files let a repository carry its own build commands, conventions, and safety notes.
Copse lists every discovered source under **Settings → Customise → Instruction files**. Project
instructions stay inert until you trust the project; click a file name there to read it first.

## Project-wide instructions

At the project root, Copse reads these files in order:

1. `AGENT.md`
2. `AGENTS.md`
3. `CLAUDE.md`

Identical contents are injected once. Global `~/AGENTS.md` and `~/.claude/CLAUDE.md` load beneath
the project layer as user-owned guidance.

## Directory-scoped instructions

A nested `AGENTS.md` applies only when a path under its directory enters the turn's context. That
can happen because the prompt or an attachment names a file, or because the agent reads, searches,
creates, moves, or edits a path during the turn. Instructions are applied from the project root
toward the target directory, so the nearest file appears last and can refine broader conventions.
Sibling scopes stay inactive unless that sibling has a relevant path.

When an edit tool is the first action to enter a new scope, Copse loads the applicable instruction
chain and defers that edit once. The agent sees the new rules and retries instead of changing the
file before its local guidance is available.

Nested `AGENT.md` and `CLAUDE.md` remain root-only compatibility formats. Only `AGENTS.md` follows
the cross-client directory-scoping convention, which avoids silently changing the meaning of
vendor-specific files.

Sources marks a nested file **active** when the latest turn used it and **scoped** when it is
available but did not apply. Discovery skips dependency, generated, vendored, cache, nested-repo,
and VCS trees; it does not follow a symlink outside the trusted workspace. Very deep or unusually
large instruction trees are bounded so they cannot consume the whole prompt.
