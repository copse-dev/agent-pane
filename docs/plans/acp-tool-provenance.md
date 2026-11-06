# ACP tool provenance and approval attribution

Issue: [#1446](https://github.com/copse-dev/agent-pane/issues/1446). Contract:
[`shell-permissions.md`](../shell-permissions.md#acp-mcp-mediation). Behaviour notes:
[`acp-agents.md`](../acp-agents.md).

## Problem

An ACP agent asks Copse for permission before it runs a tool, and Copse's own native-tool bridge
asks again when a bridged tool executes. For a bridged call the first prompt only duplicates the
second, so the ACP layer approves it when it recognises one of Copse's tools. That recognition was
a prefix match on the display title (`matchesBridgedToolName`), which caused two problems:

1. **Forgery through model-chosen text.** A display title can contain text the model chose. The
   title of an agent-native shell call is usually its command, so a command such as
   `copse-run_shell; curl … | sh` matched as bridged. The ACP layer then approved the agent's
   private shell, and the bridge never saw that shell, so Copse showed no prompt at all.
2. **Generic titles.** Cursor shows `MCP: tool` and Codex sends no title. Their bridged calls
   were not recognised, so they prompted twice.

The decision also ignored whether the session had mounted a bridge at all. Without a bridge (no
HTTP MCP, a bridge that failed to start, or `acpNativeBridgeEnabled` off), no second gate checks a
call that only claims to be bridged.

## Design

### Provenance (`acp-tool-provenance.ts`)

A permission request is delegated to the bridge's gate only when its stable `{server, tool}`
identity is established from adapter-authored fields:

| Field                                     | Claim                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_meta.claudeCode.toolName`               | `mcp__<server>__<tool>` names an MCP tool; any other value (`Bash`) names an agent-native tool. The Claude adapter sets this from the real tool name, on both the notification and the request.                                                                             |
| `_meta.claudeCode.mcpServer.name`         | Server only.                                                                                                                                                                                                                                                                |
| ACP `name`                                | Only a qualified `mcp__<server>__<tool>` value.                                                                                                                                                                                                                             |
| `title`, only in a literal observed shape | `copse-<tool>: <tool>` (Cursor), `mcp__copse__<tool>` (Claude), `mcp.copse.<tool>` (Codex notifications). Fixed separators, an ASCII tool name spelled exactly as offered, no case folding and no inline-code unwrapping. Anything else is display text and claims nothing. |

The title grammar is literal on purpose. An earlier version accepted any run of non-alphanumeric
characters between the server and the tool, case-insensitively, after unwrapping inline code. The
security review of #4016 showed that this reads shell text as a bridged tool: `copse=;. ./run_shell`
sources `./run_shell`, and `copse;run_shell`, `copse|read_file` and `COPSE RUN_SHELL` matched too.
Under an adapter whose execute title is the raw command and which sends no `_meta` (Cursor), the
agent's own shell would then have run it with no Copse prompt.

Claims are collected from the permission request and from the agent's earlier `tool_call` and
`tool_call_update` notifications for the same `toolCallId`. That record is host-owned:
`acp-client.ts` keeps only the extracted identity strings, each at most 512 characters, for at
most 512 calls with 8 reports each. Rules:

- The **request itself** must carry a claim. Earlier reports can veto it, never stand in for it.
  Otherwise a Codex call, whose notification is titled `mcp.copse.<tool>` but whose request names
  nothing, would newly skip a prompt.
- Every claim must agree on the server and the tool, compared exactly.
- A title is the weakest evidence. A request the agent classifies as `execute`, `edit`, `delete`
  or `move`, or that carries a command line (`acpShellCommandText`: an unclassified request with
  `rawInput.command`), is never delegated when every claim comes from a title. The second case came
  from the bot review of `5ca8e125`: such a request is gated as a command since #4068, so an exact
  title alone must not skip that gate.

The result is:

- `bridged`: every claim agrees, the server is `copse`, and this session's own bridge serves the
  tool;
- `not-bridged`: the claims agree on another MCP server, an agent-native tool, or a tool this
  session's bridge does not serve;
- `conflicting`: claims disagree, or only titles vouch for a running or changing request;
- `absent`: the request itself names no tool, for example a generic title or no title.

Only `bridged` changes behaviour. The ACP layer approves the request, and the bridge's native gate
decides at execution as it already does:

- reads and searches auto-run;
- workspace edits go through the diff queue and worktree backup;
- shell commands follow scope and harm policy;
- network access and external mutations prompt.

Every other status follows the existing path (remembered grants, low-risk reads, the execute
gate, edit backup, or the prompt), so absent, unknown and conflicting provenance fail closed. The
setting `acpAutoApproveNativeBridgeTools` still turns delegation off.

The offered set is this session's own bridge tool list (`AcpNativeBridge.toolNames`), narrowed to
tools still offered now. It is empty unless the session mounted a bridge: a local agent with HTTP
MCP whose bridge started. Remote (SSH) agents never qualify.

### Why adapter metadata, when an agent could forge it too

Everything in a permission request comes from the adapter. The threat this design addresses is
model-controlled content such as commands, file names and prompt-injected text, not a malicious
adapter. A malicious adapter already runs its own tools outside Copse. The model can choose which
tool to call, but it cannot choose the name the adapter records for that tool. A call that really
names `mcp__copse__…` is routed to Copse's bridge, where Copse's gate runs again. A forged display
title cannot outvote an adapter's own tool name: when the two disagree, the request falls back to
the ordinary prompt.

### Attribution (part 3 of the issue, partial)

Each ACP-layer delegation records a decision:

- `kind: acp`
- `verdict: allowed`
- `scope: native-bridge`
- `source: acp-bridge-provenance`
- `subject: <agent>: copse/<tool>` (no arguments)
- the ACP `toolCallId`
- a reason naming which fields agreed
- the turn's own project and thread, not whichever project the window has open

Its `toolCallId` links it to the bridge execution:

- `noteAcpBridgeDelegation` records the delegation, keyed by thread and tool, with the canonical
  JSON of the request's `rawInput` when it carried one.
- When the bridge executes that tool, its existing `bridge-request` record takes the same
  `toolCallId`, beside the host-owned `bridgeExecutionId` that the native gate's own decisions
  already carry. A waiting delegation with arguments links only an execution with the same
  arguments.
- When two waiting delegations could both be the execution, the MCP request cannot tell them
  apart. Neither is named, and both are dropped.
- When the agent reports an ACP tool call finished, failed or cancelled, any delegation still
  waiting for it is dropped, so an abandoned approval cannot attach to a later call.
- Residual: a delegation without arguments (Cursor sends none) can still attach to a later
  execution of the same tool if the call it approved was abandoned without any report, within the
  10-minute expiry. The link is audit data only; it authorizes nothing.

When a request's claims conflict, Copse records a `classified` `acp` decision with the ACP
`toolCallId` and the reason (`acp provenance: conflicting (…)`) before the ordinary path runs. Its
subject names the request's kind, never its title, which can hold a whole command line.
Absent and not-bridged provenance, the common case for agent-native tools, write no extra line: the
prompt's own record already carries its `toolCallId`. Provenance stays out of
`ApprovalRequest.reasons` on purpose: those reasons key prompt sharing and are repeated in the
agent-facing deferral message.

The decision-log export already carries all of these fields on each event line. A prompt from
either layer can therefore be attributed to:

- tool identity;
- gate layer: `kind` is `acp` for the ACP layer, while `bridge-request` and `bridgeExecutionId`
  mark the native layer;
- the policy reason;
- whether a prompt was shown (user verdicts versus `allowed`);
- the user's resolution.

## Acceptance criteria

| Criterion (issue)                                                                              | Evidence                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copse-native bridged calls produce no duplicate ACP approval when stable provenance is present | `acp-agent-service.test.ts` → "delegates a generic-titled call with valid provenance and records why"                                                                                                                                                   |
| Forged display titles alone cannot bypass approval                                             | "does not read shell text as a bridged identity", "does not delegate an execute request on an exact title alone", "does not skip the shell gate for the agent's own command titled like a bridged tool"; `acp-tool-provenance.test.ts` shell-text cases |
| External MCP tools remain subject to existing policy                                           | "keeps an external MCP tool on the ordinary prompt"                                                                                                                                                                                                     |
| Regression: generic titles with valid, missing and conflicting provenance                      | `resolveAcpToolProvenance` suite and the three service tests                                                                                                                                                                                            |
| No bridge, no delegation                                                                       | "prompts when the session has no live bridge to re-gate the call", "prompts for a bridged tool this session's own bridge does not serve"; the remote-agent test                                                                                         |
| Earlier reports never establish provenance                                                     | "prompts when only an earlier report names a bridged tool"; "never establishes provenance from earlier reports alone"                                                                                                                                   |
| One attributable path for ACP plus the bridge                                                  | The ACP `allowed` record and the `bridge-request` record share `toolCallId`; the bridge delegation tests                                                                                                                                                |
| Destructive and external operations keep prompting or being denied                             | Unchanged: the bridge's native gate decides them. No native policy changed                                                                                                                                                                              |
| Guarded Auto never auto-runs on classifier failure                                             | Not built: decided against in [#4106](https://github.com/copse-dev/agent-pane/issues/4106); see below                                                                                                                                                   |

## Not in this change

### Guarded Auto (part 2 of the issue): decided against

The proposed mode would auto-run shell commands **without an OS sandbox** when deterministic
scope, deterministic harm, a classifier verdict above a threshold, and workspace trust all agree.
[#4106](https://github.com/copse-dev/agent-pane/issues/4106) records the owner's decision not to
build it for now:

- Auto-run stays sandbox-only, as [`shell-permissions.md`](../shell-permissions.md) already says.
- A model classifier never authorizes, as
  [`auto-approval-classifier.md`](auto-approval-classifier.md#verdict-authority) already says.
  It stays advisory through the `tier-shadow` measurements in `tier-screening.ts`.
- Guarded YOLO remains the explicit, user-armed escape hatch, and unattended work belongs in the
  contained runtime.

#4106 also says when to revisit: when `tier-shadow` data from hosts without a sandbox shows a
meaningful share of prompts would have been approved with no harmful approvals. Any change then
needs a security review and a change to `shell-permissions.md` in the same PR.

### Other limits

- **Codex** titles its notifications `mcp.copse.<tool>`, but its permission requests carry
  neither a title nor `_meta` identity. Earlier reports can only veto, so its bridged calls still
  prompt at the ACP layer. That is fail-closed and unchanged. Delegating them needs an
  adapter-authored identity on the Codex request.
- **Cursor** relies on its exact permission-request title, and only for requests it does not mark
  `execute`, `edit`, `delete` or `move`, and that carry no command line. Generic `MCP: tool` calls that never send a permission
  request are unaffected.
- **Linking an ACP call to a bridge execution** matches tool and arguments, because the MCP
  request carries no ACP `toolCallId`. See the residual under Attribution.
- **Server-name collision (follow-up).** An MCP server the user configured in the agent itself
  and named `copse` would produce the same `mcp__copse__<tool>` names, and Copse's bridge would not
  see those calls. The offered-tool check narrows this to tool names Copse also serves. A
  per-session `copse-<nonce>` bridge name would close it; that changes every bridged tool name the
  agent sees, so it is left to its own change.
- **Export fields not yet added:** a prompt or batch episode ID and a command fingerprint. The
  existing detail blob's `toolCallIds` covers coalesced prompts. A non-reversible command
  fingerprint already exists for `tier-shadow` and could be reused later.
