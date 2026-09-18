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

## Per-tool permission settings

Settings → Permissions lists registered Copse, custom, and connected MCP tools. Each tool can keep
its inherited default or receive one explicit override:

- **Always allow** skips the tool's ordinary approval prompt. It does not bypass tool-gate hooks,
  read-only mode, diff approval, workspace trust, the OS sandbox, hard web/browser denials, or
  separate operation-specific approval such as a sandbox escape or background port binding.
- **Always ask** requires approval for every invocation. It disables remembered grants,
  annotation-based/read-only auto-allow, shell auto-approval, trusted-command routing, replay
  leases, and standing outside-project read grants for that tool.
- **Blocked** rejects before hooks, prompts, cache lookup, or handler execution. If the setting
  changes to Blocked while an approval is pending, the gate rechecks it before execution.

Resetting a row removes its override and restores the existing policy behavior. Group actions store
only the explicit tool ids currently shown in that group, so tools discovered later inherit their
own defaults. Stable MCP identities include origin, source, server, and tool name; an ambiguous
legacy execution name fails closed rather than inheriting another server's grant.

Always allow is unavailable where the product contract requires a fresh operation-specific
approval: worktree preparation, mutating GitHub actions, and custom tools declared with
`requiresApproval`. An approval prompt's existing “remember” action writes the same explicit
Always allow policy when that policy is available.

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

## Apple development operations

Apple Development uses actor-specific consent. Clicking Load targets, Build, Test, Run, or Cancel
in the panel authorizes that operation and does not open another approval modal. Main resolves the
enrolled project and thread, validates the selected target, constructs fixed `xcodebuild` or
`simctl` argument arrays, or resolves a macOS executable inside the validated built app bundle.
The process runs with normal host access. The generic project sandbox is not a functional boundary
for Xcode's package resolution, caches, Keychain and signing services, CoreSimulator, devices, and
project-controlled build phases.

The agent receives the pinned XcodeBuildMCP server only while the first-party plugin is enabled and
the active local macOS project is enrolled. All upstream workflows are available. Each call passes
through the normal MCP permission gate, including its per-tool remembered grants and corroborated
read-only auto-run option; enrollment alone does not approve agent execution. XcodeBuildMCP runs
with normal host access after that gate for the same Xcode service requirements as the panel.

Panel Build, Test, and Run operations, and XcodeBuildMCP build/test/build-and-run tools, add
`-allowProvisioningUpdates`. An authorized operation may therefore contact Apple and download or
update signing profiles. Discovery and unrelated tools do not receive the flag. Panel operation
products remain in Copse-owned per-operation scratch directories, with ownership, cancellation,
duration, and log bounds enforced. A host restart invalidates the panel operation authority epoch,
so a recovered task cannot launch a second Xcode process whose predecessor may still be alive.

## ACP MCP mediation

Configured MCP servers are never handed directly to an external ACP agent. Direct forwarding lets
the agent call a server without a host callback, which would bypass Copse's hooks, read-only mode,
and per-tool permission policy. Copse instead advertises the connected server's registered
`mcp__...` tools through its authenticated native-tool HTTP bridge. Each call returns through
`ToolRegistry` and the normal permission gate before cache lookup or handler execution.

An ACP agent that does not advertise MCP-over-HTTP support cannot mount that bridge and receives no
configured MCP tools. This is deliberately fail-closed: ACP provides no per-call host enforcement
point for a stdio or HTTP MCP server the external agent mounts itself.

## Shared Run app workflow

The titlebar/project-menu **Run app…** flow is available for detected local Apple and Android
projects independently of agent-plugin enrollment. Opening the picker authorizes loading the project
configuration (including Gradle configuration or Xcode metadata). Clicking Build, Test, or Run
authorizes the selected workflow and its project-controlled build scripts with normal host access.
The main process resolves the selected project/thread checkout and validates the discovered app,
variant, and device. It never receives arbitrary command lines from the renderer. This workflow does
not enable agent plugins or create remembered agent-tool permissions.

The shared Apple picker defaults signing-profile updates off. Its explicit per-run checkbox adds
`-allowProvisioningUpdates` only to that operation; the existing Apple plugin/MCP behavior described
above is preserved. Creating a device uses an installed runtime. Downloading an iOS runtime or an
Android system image is a separate labeled action. Android license agreements are not silently
accepted. External setup links open only the fixed Xcode/Android Studio destinations.

Operations have a duration bound and cancellable process trees. Logs are bounded; interrupted
operations are reported after restart and never replayed. A user-run local simulator/emulator opens
in Desktop with control enabled, scoped to the same project/thread. Agent-originated presentation
and remote desktops retain explicit view-only control. Closing Desktop leaves the device running;
Stop app targets only the app session launched by that workflow.

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

## Native commit signing

Copse's native `git_commit` tool honours the repository's Git signing configuration while keeping
the commit subprocess inside the project sandbox. On macOS, Settings › Permissions offers an
off-by-default grant that lets only that commit subprocess connect to the single Unix socket named
by `SSH_AUTH_SOCK`. The path must be absolute, normalised, and a socket at the time of use. Internet
access remains denied.

The grant is explicit because ssh-agent has no commit-only operation: Git hooks inherit the commit
sandbox and can ask the agent to use any loaded key. Recommend `ssh-add -c` when enabling it. Linux
does not receive the grant because seccomp cannot restrict Unix sockets by path; Windows has no
project sandbox.

When `user.signingKey` names a private-key path, Copse reads only its non-symlink `.pub` sibling
in the trusted main process and passes the public identity to Git as an inline `key::` value. The
sandbox never gains read access to the private key or the `.ssh` directory. A small pinned patch to
`@anthropic-ai/sandbox-runtime` makes its documented per-spawn `allowUnixSockets` option reach the
macOS seatbelt profile; remove that patch once upstream ships the equivalent fix.

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
  same underlying fact collapse — a heredoc, a `-c` body and an `eval` are all "runs code written
  or built inside the command itself" (so `node --eval`, which trips two rules, reads as one line),
  and `~/` and `$HOME` are both "in your home directory". The Guarded YOLO harm prompt dedupes the
  same way but joins the result into its one paragraph rather than one bullet per line.

Prompts that offer a sandbox escape name no platform: they appear only while a project sandbox is
active, which is seatbelt on macOS and bubblewrap on Linux. `permission-policy.ts` owns the
up-front prompts and `sandbox-failure.ts` the after-a-block retry; the `expects_sandbox_block`
wording stays an expectation, per the section above.

## Worktree preparation capability

Every project can use `preflight_worktree` and `prepare_worktree`. Preflight detects npm, pnpm,
Yarn Classic/modern, and Bun from an exact package-manager declaration or an unambiguous lockfile.
Python projects with `pyproject.toml` and `uv.lock` use locked uv workspace synchronization with an
installed compatible Python. uv package builds may execute repository code, which approval states;
automatic Python/tool installation is disabled.
It reports runtime requirements, dependency state, declared checks, configuration problems, exact
setup commands, and a plan fingerprint. The optional `directory` selects a nested project inside
the execution root. There is no repository-name check or implicit Electron/native requirement.

Other ecosystems and optional native setup use `.copse/worktree-preparation.json` to declare argv
commands, fingerprint inputs, and read-only checks. Unknown projects receive configuration guidance.
See [the project preparation plan](plans/project-worktree-preparation.md) for the schema and examples.
Copse's own native setup uses that same declaration. Readiness covers dependencies and declared
checks; it does not claim that builds or tests pass.

Preparation always asks once, displaying the selected project, exact package install, every declared
setup command, and its network/write scope. Project-defined setup is labelled executable repository
code. The fingerprint from preflight is required in the tool call and is checked before approval and
again before each step; changed inputs require a new approval. Grants cannot be remembered or reused
for arbitrary commands. Automatic JavaScript installs use frozen lockfiles, Socket Firewall, and
manager-specific lifecycle disabling. Custom steps retain their explicitly approved semantics.

Both tools require an enforcing OS sandbox and have no unsandboxed fallback. Preflight probes and
checks run with network blocked and the project/shared caches read-only. Each probe can write only
private disposable scratch, removed after execution, for manager bookkeeping. Preparation writes only the selected project and fixed
managed cache directories under `~/.copse/cache/` (`COPSE_DIR` relocates them), including Corepack,
npm, pnpm, Yarn, Bun, uv, Socket Firewall, and native build caches. Toolchains are read-only; native setup
uses a managed build home. No declaration may request broader filesystem grants. Temporary files
stay in the project; redirected cache roots and outside-worktree metadata inputs are rejected.
Root Git/editor configuration remains protected, while dependency metadata can be extracted.

Later project-sandbox shell commands receive read-only cache access and matching package-manager
cache variables without changing their install policy. Offline preparation blocks network for every
subprocess using kernel isolation with no proxy ports or sockets; other agents' network grants
cannot widen this boundary. Missing runtime versions or offline inputs fail with remediation.
Runtime installation/version switching and Windows sandbox support remain separate capabilities.

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

Sandboxed native commands and ACP processes redirect `TMPDIR`, `TMP`, `TEMP`, and zsh's
`TMPPREFIX` into the existing workspace scratch directory. zsh uses `TMPPREFIX` for large
heredocs independently of `TMPDIR`; leaving its default `/tmp/zsh` breaks patch commands even
when every destination file is inside the workspace. This redirect does not widen the sandbox's
writable roots or change the approval policy.

- `permission-policy.ts`: pure permission decisions, MCP decisions, outside-sandbox classification,
  and prompt-body formatting.
- `@copse/shell-guard` (`packages/shell-guard/`): the deterministic classifiers, host-free.
  `shell-argv.ts` (lexing, wrapper unwrapping, read-only tables), `shell-scope.ts` (static
  `sandbox` / `ambiguous` / `external` analysis and human-readable reasons), `shell-harm.ts`
  (the Guarded YOLO harm gate), `read-outside-project.ts` (read-shape proof and refusals),
  `gh-argv.ts` (GitHub CLI shapes), `command-routing.ts` (trusted-command routing). The
  `src/main/services/security/` files of the same names re-export them and bind the two facts
  only the app knows through `shell-guard-environment.ts`: the read-only chat-store mount and
  the scratch directories configured ACP agents declare. Docker run/pull/push and Apple
  container run/image pull/image push are hard-external; read-only list/inspect/status commands
  remain sandbox-scoped.
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
