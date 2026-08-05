# Copse — Threat model

This document states the security posture Copse holds itself to: **treat the
coding agent as untrusted by default.** That is not a claim that models are
malicious. It is an engineering stance — build the app so it stays safe even when
the agent's behaviour deviates from what we expect, whether through prompt
injection, a swapped or misconfigured model, a compromised tool, or simply
surprising behaviour at scale.

The agent reads untrusted material (repo contents, tickets, docs, logs, tool
output, web pages) and can write files and run shell commands. Once it is acting
on that material the "trusted developer environment" assumption no longer holds.
We design for that.

## Assets we protect

- **The user's machine** — the host filesystem outside the workspace, the shell,
  and anything reachable from it.
- **The workspace** — the opened project. The agent is expected to change it, but
  only with the user's awareness.
- **Secrets** — API keys (provider and MCP), and any credentials reachable from
  the user's environment.
- **Outbound network** — the ability to exfiltrate data or pull in further
  instructions/payloads.

## Adversary model

We do not assume a specific attacker. We assume the agent's effective behaviour
can be steered by any untrusted input it ingests, and design controls that hold
regardless of _why_ it deviates. Concretely, the agent's actions may be driven by:

- **Untrusted content** reaching the model — a cloned repo, an MCP/tool result, a
  fetched web page, or a file the agent itself just wrote (prompt injection /
  indirect prompt injection).
- **An untrustworthy model** — a local or third-party provider that is
  misconfigured, swapped, or adversarial.
- **A compromised tool** — a custom tool, MCP server, or project-supplied config
  that executes with more privilege than the workspace should grant.

In every case the design goal is the same: a deviation should require **explicit
human approval** before it can reach the host or the network, and should leave a
**trail** the user can inspect afterward.

## Trust boundaries

| Boundary                   | Trusted side                           | Untrusted side                                          |
| -------------------------- | -------------------------------------- | ------------------------------------------------------- |
| Workspace vs. host         | The host and the user's own config     | The opened project's contents                           |
| User dir vs. workspace     | `<userData>/tools/`, global MCP config | Project-supplied `.mcp.json` / `.cursor/mcp.json`       |
| Main process vs. renderer  | Electron main, `contextBridge` API     | Rendered web/markdown/browser content                   |
| Approved vs. auto-run      | Commands the user OK'd                 | Agent-proposed shell commands and writes                |
| Local control vs. SSH host | Local UI, approvals, thread store      | The remote account, filesystem, processes, network      |
| Copse vs. managed agent    | Local handoff and local record         | Provider-managed runtime and retained remote state      |
| Session vs. runtime        | Durable thread and execution metadata  | Replaceable process, container, VM, or provider session |

The existing design already encodes several of these: custom tools load **only**
from the user-controlled `<userData>/tools/` directory (never the workspace),
project-defined MCP servers are gated behind workspace trust, the
`contextBridge` surface is narrow, and rendered content goes through DOMPurify.

## Threat scenarios

1. **Indirect prompt injection.** Untrusted repo/tool/web content instructs the
   agent to exfiltrate secrets or run a destructive command. _Backstop:_ file
   mutations pass through workspace guards, the diff/recoverability path, and hooks;
   risky or external shell actions require approval; contained auto-run work has no
   network.
2. **Write-then-run.** The agent writes a benign-looking script, then proposes
   running it via an interpreter (`node x.js`, `bash x.sh`). The approval prompt
   shows only the launcher, not the payload. _This is a known gap — see below._
3. **Privilege via project config.** A cloned repo ships an MCP server or tool
   config hoping to auto-execute. _Backstop:_ project MCP config is trust-gated;
   full-privilege custom tools never load from the workspace.
4. **Secret egress.** The agent reads a key from the environment or settings and
   sends it outbound. _Backstop:_ model-provider secrets are scrubbed from ordinary
   child-process environments and env-var keys are never written to `settings.json`.
   Tool credentials intentionally passed to a process remain a separate exposure.
5. **Swapped/hostile model.** The configured provider returns actions aimed at
   harming the host. _Backstop:_ the approval boundary is provider-agnostic — the
   same gates apply no matter which model produced the action.
6. **Approval cliff.** A task genuinely needs network or a host tool, the user
   approves it, and the command gains full host authority beyond the capability the
   user intended. _Backstop today:_ prompts explain that the command will run outside
   the sandbox; the target design grants narrow capabilities without dropping
   unrelated containment.
7. **Remote-host compromise.** An SSH workspace or provisioned host reads or alters
   workspace data, command output, or injected credentials. _Backstop:_ the LLM loop,
   approval UI, and thread store remain local; remote credentials and data must be
   minimized. A user-supplied SSH host is still a user-selected trust boundary, not a
   Copse sandbox.
8. **Managed-runtime overclaim.** A provider-managed agent is described as having the
   same guarantees as local containment even though Copse cannot enforce or inspect
   its kernel, egress, secret injection, retention, or teardown. _Backstop:_ record the
   handoff, surface provider ownership, and never infer local guarantees.
9. **Stale or orphaned runtime.** Copse, an SSH connection, or a cloud control request
   fails during create, checkpoint, or teardown, leaving work lost or a billable
   runtime alive. _Backstop target:_ persisted desired/observed state, idempotent
   reconciliation, TTL/idle reap, and complete-only checkpoints.

## Design principles

1. **Least privilege.** The agent starts with no ability to touch the host or
   network without consent. Permissions are scoped per project, not granted
   globally and forgotten.
2. **Defense in depth.** No single control is the boundary. OS sandbox, the
   approval gate, trust gating, and secret scrubbing each assume the others can
   fail.
3. **Friction must stay productivity-neutral.** A control that makes everyday work
   painful gets disabled, and a disabled control protects nothing. The aim is to
   spend approval prompts on genuinely novel or risky actions — via per-project
   allowlists and remembered decisions — rather than on every benign command, so
   users keep the gate on instead of switching it off.
4. **Observability.** The user should be able to answer, during and after a run,
   _what did the agent actually do?_ Actions that touch the host, the workspace,
   or the network should leave an inspectable trail.
5. **Approval and containment are distinct.** Approval records human intent; it does
   not make an uncontained process safe. Preserve filesystem, process, network, and
   secret controls independently wherever the runtime can enforce them.
6. **State outlives compute.** Durable conversation and checkpoint state belongs to
   the logical thread. Processes, containers, VMs, and provider sessions are
   replaceable runtimes with explicit capabilities and lifecycle.

The target runtime, egress, credential, lifecycle, and checkpoint architecture is in
[`plans/execution-runtime-security.md`](plans/execution-runtime-security.md).

## Execution surfaces and guarantees

| Surface                                  | Current guarantee                                                                                   | Important limitation                                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local shell/background work on macOS     | Workspace-scoped ASRT filesystem policy and deny-all network for contained auto-run work            | Approved external work may run with full host authority                                                                                                     |
| Local shell/background work without ASRT | Conservative approval; the classifier cannot authorize execution                                    | An approved command runs with the user's authority                                                                                                          |
| Local ACP agent                          | macOS workspace profile with configured agent destinations; native tools re-enter Copse's gate      | Network allow-list implementation is process-global; enforcement is absent off macOS                                                                        |
| SSH workspace                            | Local approval policy and thread ownership; remote filesystem/process routing over SSH              | The remote account and host enforce filesystem, process, and network security                                                                               |
| Managed remote agent                     | Local handoff, PII-redaction option, durable provider-session link, and local transcript projection | Runtime isolation, network, credentials, retention, and teardown are provider-owned; the current Anthropic environment request uses unrestricted networking |
| Remote e2e                               | Fresh one-shot container per run, explicit snapshot transfer, bounded dev-host TTL                  | Developer/CI tooling, not a product agent runtime or multi-tenant security claim                                                                            |
| Copse-provisioned cloud workspace        | Proposed only                                                                                       | Must satisfy the gates in the execution-runtime-security and cloud-workspace plans before release                                                           |

## Current controls

- **Auto-approval classifier.** A deterministic allow-list of command _shapes_
  (`git fetch`/`push` against a remote already configured in the repository, `gh`
  reads and PR creation, local git operations, read-only shell commands) runs
  without a prompt, tiered by blast radius and capped by a user-chosen level
  (default: reads only). It is consulted only after the policy has already decided
  to prompt, so it can turn a prompt into an allow but can never widen an `allow`
  or soften a `deny`. It fails closed on any unrecognised segment, flag, or
  argument, refuses substitution/redirection/interpreters, excludes destructive
  git and `gh` forms by name, and is honoured only in a trusted workspace with
  auto-run on. No model verdict participates. Every grant is recorded to the
  decision log. See [`plans/auto-approval-classifier.md`](plans/auto-approval-classifier.md);
  note the git-hook caveat recorded there.
- **Approval and mutation gates.** Risky/external shell commands ask for explicit
  approval; custom tools prompt or use their documented remembered-grant path. File
  mutations flow through workspace guards, the diff queue, hooks, and recoverability
  checks.
- **Thread-scoped read-outside-the-project grant.** A command that only reads
  out-of-project paths, and whose every path the analyser can resolve, is asked
  as a read-access question whose approval covers that shape for the rest of the
  thread; the prompt also offers a one-command answer. The grant lives in memory
  only, never crosses threads, and authorises nothing on its own — each later
  command is re-analysed and must prove it is a plain read. The shape fails closed
  on any unrecognised command head, write flag, redirect, variable expansion, or
  privilege wrapper, and refuses credential targets (`.env*`, private keys,
  `~/.ssh`, `~/.aws`, `.netrc`, `.config/gh`) and whole-home/root targets outright
  so they always prompt. The residual risk is stated on the prompt: a granted read
  of a directory can still traverse into a file the analyser would have refused as
  a direct target. The grant is in-memory, but it is not unaccountable: the
  answered prompt and every command the grant later covers are written to the
  durable decision log, naming the paths and whether the answer was made sticky.
- **OS sandbox (macOS).** Sandbox-contained commands auto-run inside a seatbelt
  profile; external commands prompt and run outside only when approved.
- **Global network-scope guard.** When a sandboxed ACP agent or a loopback
  background task temporarily widens ASRT's process-global network allowlist,
  all shell commands, background starts, and newly opened integrated terminals
  require explicit approval until the final scope releases. This prevents
  unrelated auto-run work inheriting temporary network egress.
- **Integrated terminal is user-directed.** Shells tabs the user opens run outside
  the project seatbelt (full host access by design). Agent shell confinement stays
  on `run_shell` / `run_background`. Where no OS sandbox is available, or when an
  SSH-backed PTY necessarily runs outside the local seatbelt, opening a terminal
  presents an explicit warning and approval.
- **Trust gating.** Project-supplied MCP config is gated behind workspace trust;
  full-privilege custom tools load only from `<userData>/tools/`.
- **Secret handling.** Provider keys stored via `safeStorage` where a keyring is
  available; model-provider secrets scrubbed from ordinary spawned child-process
  environments; env-var keys never persisted to disk. Explicit tool/server/agent
  configuration can still pass selected credentials by design.
- **Renderer hardening.** Narrow `contextBridge` API, main-frame IPC gating,
  strict DOMPurify on rendered content.
- **Filesystem-native thread history + export.** Every thread lives under
  `~/.copse/workspace/<projectId>/<threadId>/` (or `COPSE_WORKSPACE_DIR`) with
  `meta.json`, an event spine, readable message files, blobs, and nested subagents.
  Tool arguments/results and hook records remain inspectable and exportable.

## Known gaps

These are the places where the posture above is aspirational rather than
enforced, ordered by how much they widen the blast radius:

- **No OS sandbox on Linux/Windows.** The seatbelt boundary is `darwin`-only. On
  other platforms, every agent-proposed shell command requires explicit approval
  unless the user has explicitly allow-listed its binary as trusted, or it matches
  a shape on the deterministic auto-approval allow-list; the optional local
  **safety-model** classifier can only make strict-mode blocks, never authorize
  host execution. Approved commands run with the user's full privilege. The
  auto-approval shapes are chosen to be bounded and recoverable, but off macOS
  nothing contains them — in particular the `local-write` and `remote-write` tiers
  run this repository's git hooks, which are code, with no containment. On those
  platforms treat any level above `read` as a trust decision about the repository.
- **Approved external commands lose containment.** The contained macOS profile denies
  network and out-of-workspace access, but an approved external command or retry runs
  fully outside that profile. The intended fix is scoped egress/operation grants,
  retaining unrelated filesystem and process controls.
- **Network mediation is not per execution.** ASRT's allow-list is process-global.
  Copse forces overlapping commands to prompt while a scope is widened, preventing
  silent inheritance, but cannot attribute the allow-list itself to one child.
- **Tool credentials can reach child processes.** Model-provider keys are scrubbed,
  while credentials such as GitHub, package-registry, and cloud tokens may remain for
  tools that need them. The target is brokered use without exposing the raw value to
  the workload.
- **Remote guarantees are heterogeneous.** The local seatbelt does not protect an SSH
  host. Managed-agent isolation is provider-owned, and the current Anthropic managed
  environment is requested with unrestricted networking. Copse needs capability
  reporting and narrower requested policies where provider APIs support them.
- **Write-then-run context remains incomplete.** An interpreter invocation can execute
  a file the agent just wrote, while the approval prompt primarily describes the
  launcher. The command analyzer is token-aware and conservative, but provenance-aware
  prompts and runtime enforcement would give the user a better decision surface.
- **The action record is a transcript, not an audit log.** Tool calls (args +
  results) and hook runs are persisted and exportable, which covers much of "what
  did the agent do?". But the record is not tamper-evident, does not independently
  observe everything an approved process does, and does not yet canonically record
  every permission, egress, credential, lifecycle, checkpoint, and teardown event.

Closing the approval-to-full-host cliff and Linux/Windows isolation gap are the two
highest-leverage changes. Per-execution network and credential mediation is the shared
foundation for local and provisioned-cloud runtimes. Canonical runtime events and
eventual tamper evidence then make those boundaries inspectable after a run.
