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

The dropdown is a fixed allow-list of extra command shapes. It cannot skip a
prompt for unrecognized shapes such as `npx`, installs, force-push, `$(…)`, or
`git fetch` with a URL instead of a configured remote. A command such as
`npm test` may still auto-run because it stays inside the project sandbox;
that permission comes from the checkbox, not the dropdown.

This page describes standard shell mode. Per-tool overrides, trusted commands
and Guarded YOLO are separate controls described below.

## Levels

| Level                          | What it may skip asking for                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Off                            | Nothing extra. Every external command still asks.                                                                                                           |
| Reads (default)                | Local reads (`ls`, `grep`, `git status` / `log` / `diff`) and network _reads_ against a remote already in `.git/config` (`git fetch origin`, `gh pr view`). |
| Reads + local commits          | Also `git add`, `git commit`, `git checkout -b`, `git stash`. These run repository git hooks.                                                               |
| Reads + local commits + pushes | Also `git push` (no force) and `gh pr create` against this project’s repo.                                                                                  |

A URL never qualifies. The remote must be a _name_ this checkout already has.

These tiers govern shell command shapes, including `gh pr create` through the
shell. The dedicated GitHub Create PR tool keeps its own approval requirement.
Recognized network commands may run **outside** the project sandbox when the
tier authorizes them; skipping a prompt does not imply confinement.

## When the dropdown does nothing

The dropdown cannot skip a prompt when:

- the workspace is not trusted;
- auto-run (the checkbox above the dropdown) is off;
- there is no project sandbox — Windows, or a sandbox that failed to start.
  Every recognised shape asks without containment, reads included: these
  shapes are granted by class rather than typed out one binary at a time, so
  running them unprompted on an uncontained host is not a bar we hold.
- the command is not on the allow-list and needs approval under the ordinary
  shell policy.

**You should see** `git fetch origin` and `git status` run without a dialog in
a trusted macOS or Linux project with the default Reads level and a live
sandbox. In standard mode without a separate explicit grant, `git push` still
asks until you raise the level; `curl` and `npm install` ask at every tier.

## Trusted commands

The trusted-command list (for example `xcodebuild`) is a different grant: you
named a binary that needs host access. Matching commands run **outside the
project sandbox**, using your user account's filesystem and network permissions.
This can be useful for host tools such as `xcodebuild`.

The grant requires a trusted project and auto-run enabled. Copse checks every
command segment; an untrusted additional command does not inherit the grant.
An **Always ask** tool override suppresses trusted-command routing. A missing
OS sandbox does not revoke a binary you explicitly trusted: this grant is
separate from the shape-based dropdown. Remove the binary from the list to
withdraw the grant.

## Per-tool policies

Settings → Permissions also lists Copse, custom and connected MCP tools.

| Policy       | What it changes                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| Inherited    | Uses the tool's existing permission rules. Reset removes an override.                                             |
| Always allow | Skips ordinary tool approval. Sandbox escapes, workspace guards, diff review, hooks and hard denials still apply. |
| Always ask   | Asks for every call; remembered grants and ordinary auto-approval cannot skip it.                                 |
| Blocked      | Rejects the call before execution.                                                                                |

Always allow is unavailable for operations that require fresh consent, such as
worktree preparation, dedicated mutating GitHub actions, host GUI launch and
custom tools declared to require approval. Some tools also have an internal
approval step: revealing redacted personal data always asks for that value.

## Other run modes

**Read-only agent mode** allows only an explicit list of inspection tools.
Shell, writes and tools outside that list are blocked even if their per-tool
policy says Always allow. MCP tools need read-only, non-destructive hints and
still pass their normal approval gate.

**Guarded YOLO** is enabled for a thread from the composer and lasts until
disabled or the app restarts. Routine shell commands skip scope prompts, while
the harm gate can still ask once or deny. Commands that fit the project sandbox
stay contained; external commands can run with host access. Dedicated GitHub
writes and operation-specific consent still have their own rules.

**Deferred approvals** queue work needing approval instead of opening a modal.
Queued work has not been authorized or executed. An automation can have exact
schedule-specific grants for eligible GitHub actions or MCP tools; those grants
do not authorize arbitrary shell commands, file edits or web origins.

**Unattended container runs** have their own containment policy and are mutually
exclusive with Guarded YOLO. See the [sandbox and container guide](project-sandbox.md).
External ACP agents can also expose their own permission modes; those do not
replace Copse's host permission checks or execution boundary.

For the complete per-tool restrictions, see the contributor
[permission contract](../shell-permissions.md#high-level-tool-restrictions).
