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

## ssh-agent access for sandboxed agents

Off by default, per-user, macOS only. `agentSshAgentSocketAccess` (default `false`) lets a
sandboxed ACP agent `connect()` to the socket `SSH_AUTH_SOCK` names, and nothing else.

The default costs something real, so it is a deliberate choice rather than an oversight. A
passphrase-protected SSH signing key is only usable through `ssh-agent`: with the socket denied,
`ssh-keygen -Y sign` falls back to the key file and needs a passphrase it cannot ask for, so every
agent-authored commit lands unsigned even where `commit.gpgsign=true` and the same commit signs
fine from an unsandboxed shell (#2320).

The reason it is still off by default: an agent socket is a confused-deputy channel. The sandbox
keeps preventing the agent process from _reading_ the private key, but the socket lets it ask
ssh-agent to _use_ that key, and the ssh-agent protocol has no "commit signing only" scope.
Whoever reaches the socket can sign arbitrary data and authenticate anywhere those keys are
trusted — and unlike the auto-run profile, an ACP agent's profile is not network-denied
(`acpAgentSandboxOverlay` admits the agent's own endpoints). `ssh-add -c` makes each use require
confirmation and is the recommended pairing.

Prefer this to a passphrase-less signing key. That alternative is the broader weakening: it leaves
a directly usable key on disk for every process on the machine, sandboxed or not, permanently,
and every contributor has to repeat the setup. This grant is scoped to processes Copse spawns and
leaves the key's passphrase protection intact.

**Scope of the grant.** Exactly the one path from `SSH_AUTH_SOCK` — never a directory, never
`allowAllUnixSockets`. A relative or empty value grants nothing rather than emitting a rule that
does not mean what it says. An agent that has not opted in gets a byte-identical profile to the
one it got before the setting existed.

**macOS only.** ASRT expresses the boundary differently per platform. The macOS seatbelt takes a
path allow-list (`network.allowUnixSockets`) and emits one `(subpath …)` filter per entry, so the
grant can name a single socket. Linux enforces it with a seccomp-bpf filter on
`socket(AF_UNIX, …)`, and seccomp cannot inspect user-space memory to read a socket path — its
only knob is `allowAllUnixSockets`, which would open every unix socket in the sandbox (Docker,
Gradle, the display server) to buy one. Copse does not make that trade, so Linux keeps its current
profile and the setting has no effect there. Windows has no sandbox at all.

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
  on Windows and after init failure. `ssh-agent-socket.ts` holds the ssh-agent carve-out policy
  as a pure function; `config.ts` maps its result onto the overlay's `allowUnixSockets` and
  `acp-client.ts` reads the setting and the spawned child's own `SSH_AUTH_SOCK`.

`permission-platform.test.ts` pins the platform matrix; `permission-gate.test.ts` and
`auto-approval-config.test.ts` pin gate wiring, the sandbox auto-approval gate, and MCP decisions.
Update this document and those tests with any intentional contract change.
