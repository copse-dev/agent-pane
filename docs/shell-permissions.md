# Shell and tool permission contract

This document describes current shipped behavior. Read it before changing permission policy, shell
scope analysis, the macOS project sandbox, escalation, or approval UI. Historical design decisions
remain in `docs/plans/`; this is the durable cross-platform contract.

Shell command auto-run is gated by the pure `decideShellPermission` function in
`src/main/services/permission-policy.ts`, called from `permission-gate.ts`. The OS sandbox is
macOS-only. Other platforms rely on static analysis plus an optional classifier, but the classifier
is never an authorization boundary.

## Platform matrix

| Situation                                   | Sandbox-contained command                                               | Hard-external command (network download, `git push`, install, `~/...`) | Ambiguous “may reach” command (`gh`, `nc`, cloud CLIs, `open <url>`)                                                                           |
| ------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS, ASRT active**                      | Auto-runs inside the seatbelt sandbox. The classifier is not consulted. | Prompts first, then runs outside the sandbox.                          | Auto-runs inside seatbelt. A verified block offers retry outside. `expects_sandbox_block: true` can move that prompt before the first attempt. |
| **macOS sandbox failure / Linux / Windows** | Prompts because no OS sandbox can contain it.                           | Prompts, unless strict-mode hard-deny applies.                         | Prompts and is treated as external.                                                                                                            |
| **Auto-run disabled**                       | Prompts.                                                                | Prompts.                                                               | Prompts.                                                                                                                                       |

The ambiguous tier exists because short command names also appear harmlessly as paths or arguments.
On macOS, seatbelt—not a fuzzy match—decides whether they escape. Without a sandbox there is no
containment boundary, so ambiguity must prompt.

## Strict mode and expected blocks

`safetyExternalDenyThreshold` defaults to `1` (off). At a lower threshold, a command is hard-denied
only when both conditions hold:

1. the classifier is at least that confident the command is external; and
2. deterministic analysis reports a destructive signal in `dangerousInSandboxReasons`.

Strict mode never denies a merely external command. Without the destructive signal it is surfaced
for approval.

An agent may pass `expects_sandbox_block: true` to `run_shell` when an ambiguous command is expected
to need network or outside-workspace access. This only advances the same unsandboxed-retry prompt:

- a hard-external command already prompts and runs outside;
- a sandbox-contained command ignores the hint and must earn escalation through a verified block;
- declining the advanced prompt runs the command in the sandbox without prompting again on failure.

Approval copy must describe this as an expectation, not a confirmed sandbox failure.

## Read access outside the project

A command that only reads fully-accounted-for paths outside the project receives the narrower
“Allow read access outside of the project?” question. Its primary action grants that proven read
shape for the remainder of the thread, in memory only. An expanded “Approve this command” action
approves one invocation without a grant.

The grant authorizes no command by itself. `read-outside-project.ts` re-analyzes every later command
and must prove it is a plain read through a fail-closed allow-list. An unknown command head, write
flag, redirect, environment variable, or privilege wrapper falls back to the ordinary prompt.
Credential targets (`.env*`, `*.pem`, `~/.ssh`, `~/.aws`, `.netrc`, `.config/gh`, and similar) and
paths as broad as `~` or `/` are never eligible.

This applies on every platform. Off macOS there is no seatbelt to leave, but the access is still
outside the project and requires the same narrowly reasoned permission.

The in-memory grant disappears on restart. The decision record does not: an answer appends a
`decisions.jsonl` event at `scope: external-read`, including the paths and whether the grant was
remembered. Each later allowed command records a verdict sourced to `read-outside-grant`.

## Implementation map

- `permission-policy.ts`: pure permission decisions, MCP decisions, outside-sandbox classification,
  and prompt-body formatting.
- `shell-scope.ts`: static `sandbox` / `ambiguous` / `external` analysis and human-readable reasons.
- `read-outside-project.ts` and `read-outside-grant.ts`: read-shape proof, refusals, and thread grant.
- `safety-classifier.ts`: optional LM Studio classifier used only when the OS sandbox is unavailable.
- `project-sandbox/`: macOS ASRT integration. `isProjectSandboxEnabled()` is always false off Darwin.

`permission-platform.test.ts` pins the platform matrix; `permission-gate.test.ts` pins gate wiring
and MCP decisions. Update this document and those tests with any intentional contract change.
