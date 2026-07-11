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

| Boundary                  | Trusted side                           | Untrusted side                                    |
| ------------------------- | -------------------------------------- | ------------------------------------------------- |
| Workspace vs. host        | The host and the user's own config     | The opened project's contents                     |
| User dir vs. workspace    | `<userData>/tools/`, global MCP config | Project-supplied `.mcp.json` / `.cursor/mcp.json` |
| Main process vs. renderer | Electron main, `contextBridge` API     | Rendered web/markdown/browser content             |
| Approved vs. auto-run     | Commands the user OK'd                 | Agent-proposed shell commands and writes          |

The existing design already encodes several of these: custom tools load **only**
from the user-controlled `<userData>/tools/` directory (never the workspace),
project-defined MCP servers are gated behind workspace trust, the
`contextBridge` surface is narrow, and rendered content goes through DOMPurify.

## Threat scenarios

1. **Indirect prompt injection.** Untrusted repo/tool/web content instructs the
   agent to exfiltrate secrets or run a destructive command. _Backstop:_ writes
   and shell commands wait for approval; outbound network actions are visible.
2. **Write-then-run.** The agent writes a benign-looking script, then proposes
   running it via an interpreter (`node x.js`, `bash x.sh`). The approval prompt
   shows only the launcher, not the payload. _This is a known gap — see below._
3. **Privilege via project config.** A cloned repo ships an MCP server or tool
   config hoping to auto-execute. _Backstop:_ project MCP config is trust-gated;
   full-privilege custom tools never load from the workspace.
4. **Secret egress.** The agent reads a key from the environment or settings and
   sends it outbound. _Backstop:_ secrets are scrubbed from child-process
   environments; env-var keys are never written to `settings.json`.
5. **Swapped/hostile model.** The configured provider returns actions aimed at
   harming the host. _Backstop:_ the approval boundary is provider-agnostic — the
   same gates apply no matter which model produced the action.

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

## Current controls

- **Approval gate.** Writes and shell commands wait for explicit approval; custom
  tools always prompt before running.
- **OS sandbox (macOS).** Sandbox-contained commands auto-run inside a seatbelt
  profile; external commands prompt and run outside only when approved.
- **Global network-scope guard.** When a sandboxed ACP agent or a loopback
  background task temporarily widens ASRT's process-global network allowlist,
  all shell and background-start commands require explicit approval until the
  final scope releases. This prevents unrelated auto-run commands inheriting
  temporary network egress.
- **Trust gating.** Project-supplied MCP config is gated behind workspace trust;
  full-privilege custom tools load only from `<userData>/tools/`.
- **Secret handling.** Provider keys stored via `safeStorage` where a keyring is
  available; secrets scrubbed from spawned child-process environments; env-var
  keys never persisted to disk.
- **Renderer hardening.** Narrow `contextBridge` API, main-frame IPC gating,
  strict DOMPurify on rendered content.
- **Persisted thread history + export.** Every thread is autosaved to the
  main-process electron-store (a JSON file under the `copse-panel` userData dir),
  with each message's tool calls — args _and_ results — retained inline. Any
  thread can be exported to JSONL (`downloadThreadJsonl`), giving an inspectable,
  greppable record of what the agent did across a run.

## Known gaps

These are the places where the posture above is aspirational rather than
enforced, ordered by how much they widen the blast radius:

- **No OS sandbox on Linux/Windows.** The seatbelt boundary is `darwin`-only. On
  other platforms, every agent-proposed shell command requires explicit approval
  unless the user has explicitly allow-listed its binary as trusted; the optional
  local classifier can only make strict-mode blocks, never authorize host
  execution. Approved commands run with the user's full privilege.
- **Auto-run classifier is bypassable.** The auto-run decision is made by pattern
  matching over the raw command string, which is evadable (quote-splitting,
  interpreter-run of agent-written files, `git` transport tricks). It should fail
  toward prompting, and treat "run a file the agent just wrote" as approval-worthy.
- **The action record is a transcript, not an audit log.** Tool calls (args +
  results) are persisted and exportable, which covers most of "what did the agent
  do?". But the record has three audit-grade weaknesses: (1) it's plaintext JSON
  in the userData dir — the same trust zone as the app — so it is neither
  append-only nor tamper-evident, and a host compromise could edit or delete it;
  (2) it captures the tool I/O the agent reported through the registry, not an
  independent OS-level record of everything a spawned shell process did once
  approved; (3) export is a manual, per-thread action rather than a continuous
  stream.

Closing the Linux/Windows isolation gap is the single highest-leverage change.
Hardening the existing thread record into a tamper-evident, append-only audit log
is the natural follow-up — the data is already captured; what's missing are the
audit-grade properties.
