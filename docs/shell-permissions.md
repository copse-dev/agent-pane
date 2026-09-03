# Shell and tool permission contract

This document describes current shipped behavior. Read it before changing permission policy, shell
scope analysis, the project sandbox, escalation, or approval UI. Historical design decisions
remain in `docs/plans/`; this is the durable cross-platform contract.

Shell command auto-run is gated by the pure `decideShellPermission` function in
`src/main/services/security/permission-policy.ts`, called from `permission-gate.ts`. The OS sandbox
runs on macOS (ASRT seatbelt) and Linux (bubblewrap). Windows, and any platform whose sandbox failed
to start, has no containment: every command prompts. The optional LM Studio classifier is never an
authorization boundary. The deterministic auto-approval classifier may skip a prompt only while the
project sandbox is active.

## Platform matrix

| Situation                                | Sandbox-contained command                                                    | Hard-external command (network download, `git push`, install, `~/...`)                                                               | Ambiguous “may reach” command (`gh`, `nc`, cloud CLIs, `open <url>`)                                                                                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS ASRT / Linux bubblewrap active** | Auto-runs inside the project sandbox. The model classifier is not consulted. | Prompts first, then runs outside the sandbox. Recognised low-risk shapes (`git push origin`) may skip that prompt via auto-approval. | Auto-runs inside the sandbox. A verified block offers retry outside. This includes opaque interpreter heredocs, whose effects the sandbox contains. `expects_sandbox_block: true` can move that prompt before the first attempt. |
| **Windows / sandbox init failure**       | Prompts because no OS sandbox can contain it. Auto-approval does not fire.   | Prompts, unless strict-mode hard-deny applies. Auto-approval does not fire.                                                          | Prompts and is treated as external. Auto-approval does not fire.                                                                                                                                                                 |
| **Auto-run disabled**                    | Prompts.                                                                     | Prompts.                                                                                                                             | Prompts.                                                                                                                                                                                                                         |

The ambiguous tier exists because short command names also appear harmlessly as paths or arguments.
Where a sandbox is active, the sandbox—not a fuzzy match—decides whether they escape. Without a
sandbox there is no containment boundary, so ambiguity must prompt, and auto-approval cannot skip
that prompt.

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

This applies on every platform. Off macOS/Linux there is no seatbelt/bubblewrap to leave, but the
access is still outside the project and requires the same narrowly reasoned permission.

The in-memory grant disappears on restart. The decision record does not: an answer appends a
`decision` spine event at `scope: external-read`, including the paths and whether the grant was
remembered. Each later allowed command records a verdict sourced to `read-outside-grant`.

## What an approval prompt says

Classifier reasons are **identifiers, not copy**. The regex pass and the token pass share them
verbatim so the two dedupe against each other, and every answered prompt writes them into the
decision spine, so they must stay stable — which is why they read like rules
(`inline script (interpreter -c/-e/--eval)`) rather than like something a user can act on.

`shell-scope.ts` therefore keeps a second table, `SCOPE_REASON_TEXT`, holding one plain-English
sentence per reason, and `describeShellScopeReasons` resolves a reason list into sentences at the
moment a prompt is built. The shell prompt formatters in `permission-policy.ts` render those as a
bullet per line; the Guarded YOLO harm prompt resolves the same sentences but keeps its existing
one-paragraph `Potential harm: …` shape, because it is capped by length rather than by line. Logs,
hooks and the decision spine keep the identifiers.

Two properties this contract depends on:

- **Every rule has copy.** `ScopeReason` is derived from the keys of `SCOPE_REASON_TEXT` and
  annotates the pattern tables, the shared reason constants, and the accumulators both classifier
  passes push through, so a new classifier rule whose reason has no sentence fails to typecheck.
  The one deliberate exception is the runtime-built `absolute path outside workspace: …`, which
  bakes in an operand and so is matched by prefix instead; anything still unrecognised is shown
  verbatim rather than dropped.
- **One concern, one line.** Deduping happens on the resolved sentence, so rules that describe the
  same underlying fact collapse — a heredoc and a `-c` body are both "runs a script written inside
  the command itself", and `~/` and `$HOME` are both "in your home directory".

Prompts that offer a sandbox escape name no platform: they appear only while a project sandbox is
active, which is seatbelt on macOS and bubblewrap on Linux. `permission-policy.ts` owns the
up-front prompts and `sandbox-failure.ts` the after-a-block retry; the `expects_sandbox_block`
wording stays an expectation, per the section above.

## Guarded YOLO

Guarded YOLO is a session-only, thread-scoped mode armed from the composer footer. It becomes
active at the next run start and stays active until disabled or the app restarts. It does not
disable the OS sandbox.

While active:

- Routine shell commands skip ordinary scope prompts, subject to the host-owned harm gate in
  `shell-harm.ts` (`allow` / one-time `prompt` / hard `deny`).
- The thread is treated as holding the outside-project read grant above. Eligible plain reads of
  non-credential paths auto-run; on macOS/Linux they stay contained with a widened `allowRead`
  seatbelt rather than a full sandbox escape. Credential targets and paths as broad as `~` or `/`
  remain hard-denied by the harm gate.
- Writing or opaque GitHub CLI forms (`gh pr create`, `gh api`, …) prompt via the harm gate.
  Dedicated mutating GitHub tools (`GITHUB_WRITE_TOOLS`) still always prompt. Read-only `gh`
  carve-outs keep the normal sandboxed path.
- Other network / outside-workspace commands may still auto-run unsandboxed when the harm gate
  allows them.

Update this document and the Guarded YOLO / harm / read-outside tests with any intentional change.

## Implementation map

- `permission-policy.ts`: pure permission decisions, MCP decisions, outside-sandbox classification,
  and prompt-body formatting.
- `@copse/shell-guard` (`packages/shell-guard/`): the deterministic classifiers, host-free.
  `shell-argv.ts` (lexing, wrapper unwrapping, read-only tables), `shell-scope.ts` (static
  `sandbox` / `ambiguous` / `external` analysis and human-readable reasons), `shell-harm.ts`
  (the Guarded YOLO harm gate), `read-outside-project.ts` (read-shape proof and refusals),
  `gh-argv.ts` (GitHub CLI shapes), `command-routing.ts` (trusted-command routing). The
  `src/main/services/security/` files of the same names re-export them and bind the two facts
  only the app knows through `shell-guard-environment.ts`: the read-only chat-store mount and
  the scratch directories configured ACP agents declare.
- `read-outside-grant.ts`: the thread-scoped read grant; the approval-prompt copy for it stays in
  `read-outside-project.ts` beside the other prompt formatters.
- `safety-classifier.ts`: optional LM Studio classifier used only when the OS sandbox is unavailable.
- `auto-approval.ts` / `auto-approval-config.ts`: deterministic shape allow-list; honoured only
  while the project sandbox is active, auto-run is on, and the workspace is trusted. Write tiers
  are additionally capped at `read` if a caller reaches the level helper without a sandbox.
- `project-sandbox/`: ASRT on macOS and bubblewrap on Linux. `isProjectSandboxEnabled()` is false
  on Windows and after init failure.

`permission-platform.test.ts` pins the platform matrix; `permission-gate.test.ts` and
`auto-approval-config.test.ts` pin gate wiring, the sandbox auto-approval gate, and MCP decisions.
Update this document and those tests with any intentional contract change.
