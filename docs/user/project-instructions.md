---
title: Project instructions
description: Give Copse global, project-wide, or directory-scoped guidance with AGENTS.md and CLAUDE.md files.
---

# Project instructions

Instruction files let a repository carry its own build commands, conventions, and safety notes.
Copse lists every discovered source under **Settings → Customise → Instruction files**. Project
instructions stay inert until you trust the project; click a file name there to read it first.

Instruction compatibility is supplied by three stable first-party plugins under **Settings →
Customise → Plugins**:

- **Claude.md** owns `CLAUDE.md`, `.claude/CLAUDE.md`, and `CLAUDE.local.md` sources.
- **Agents.md** owns `AGENT.md`, `AGENTS.md`, and `.claude/AGENTS.md` sources plus the Project
  instructions mode.
- **Cursor rules** owns `.cursor/rules` loading and the agent-requested rules catalog.

The plugins choose sources; Copse's core instruction engine still performs all filesystem reads,
workspace-trust checks, symlink containment, size limits, deduplication, and prompt framing. Only
first-party plugins may contribute an always-on instruction source.

## Project instructions mode

The Agents.md plugin exposes the same four values as Claude Code's built-in `agents-md` mod:

| value                     | behavior                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-md-or-agents-md`  | Load the project's CLAUDE.md family, or use its AGENTS.md family when the project has no CLAUDE.md-family file of its own. This is the default for new profiles.                 |
| `claude-md-and-agents-md` | Load both families, with each directory's Claude files before its Agents files. Existing Copse profiles migrate to this value so an upgrade does not silently drop instructions. |
| `claude-md`               | Load only the CLAUDE.md family.                                                                                                                                                  |
| `managed-only`            | Leave out user, project, local, and Cursor rule files; keep only Copse's system/managed instruction layer.                                                                       |

Disabling the Agents.md plugin restores CLAUDE.md-only behavior. Disabling Claude.md lets the
Agents fallback load even when dormant CLAUDE.md files exist. Changes apply to newly assembled
turns; historical messages are never rewritten.

## Project-wide instructions

At the project root, the combined mode reads `CLAUDE.md`, `.claude/CLAUDE.md`, and
`CLAUDE.local.md`, followed by the historical root-only `AGENT.md` spelling, `AGENTS.md`, and
`.claude/AGENTS.md`. Identical contents are injected once. Global `~/.claude/CLAUDE.md` and
`~/AGENTS.md` load as user-owned guidance when their source family is selected.

## Directory-scoped instructions

A nested `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, or
`.claude/AGENTS.md` applies only when a path under its owning directory enters the turn's context.
In fallback mode, a directory's Claude file claims that directory and its Agents file is omitted.
A path enters context when the prompt or an attachment names it, or when one of Copse's built-in
file tools touches it: `read_file`, `list_dir`, `search_code`, `search_codebase`,
`read_staged_diff`, `write_file`, `str_replace`, `delete_file`, `rename_file`, and
`make_directory`. Nothing else activates a nested file: a `run_shell` command that reads or writes
under the directory, an ACP agent's own file access, and a subagent's reads do not count.
Instructions are applied from the project root toward the target directory, so the nearest file
appears last and can refine broader conventions. Sibling scopes stay inactive unless that sibling
has a relevant path.

When an edit tool is the first action to enter a new scope, Copse loads the applicable instruction
chain and defers that edit once. The agent sees the new rules and retries instead of changing the
file before its local guidance is available. Each activation adds a one-line note to the
transcript naming the file that was loaded.

During a turn, Copse reads only the ancestor directories of referenced paths, rather than scanning
unrelated parts of the repository. Each scope, including missing instruction files, is read once
when first referenced and shared by later tool calls. Writing, moving, or removing a nested
Agents or Claude instruction file with a file tool invalidates those reads, so a later tool can
activate newly available instructions. Rules already injected remain in the current turn; changes
to those rules apply next turn. External edits to an already-read scope are also seen next turn. A
newly referenced scope is read when the agent first enters it. Settings still discovers the full
bounded inventory.

The singular `AGENT.md` spelling remains root-only compatibility behavior. The other Claude and
Agents spellings follow the same bounded directory-scoping engine.

Sources marks a nested file **active** when the latest turn used it, **scoped** when it is
available but did not apply, and **duplicate** when its text repeats a file already listed (the
text is loaded once, through that file). Discovery skips dependency, generated, vendored, cache,
nested-repo, and VCS trees; it does not follow a symlink outside the trusted workspace. Very deep
or unusually large instruction trees are bounded so they cannot consume the whole prompt; when
discovery stops at that bound, Sources says the list may be incomplete.
