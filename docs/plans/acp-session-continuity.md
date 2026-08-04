# ACP session continuity

Status: **Proposed**

Date: **2026-07-30**

## Outcome

An ACP conversation should survive an idle reap, agent-process failure, Copse
restart, and an intentional hand-off to another ACP surface. Returning to the
same Copse thread should reconnect to the same agent session when possible and
must accurately represent any history that Copse cannot display.

This applies to every ACP agent Copse exposes: Claude Agent ACP, Claude Code ACP,
Codex ACP, Cursor ACP, Gemini CLI ACP, agents started over SSH, and custom agent
commands. The implementation is capability-driven; these names are a
compatibility matrix, not branches in the lifecycle code.

There are two directions:

1. **Copse as ACP client:** Copse reconnects to an external agent's durable
   session and can explicitly attach a session created in another client.
2. **Copse as ACP agent (`copse --acp`):** another client can reconnect to a
   Copse session after the ACP process or client restarts, and the Copse GUI can
   open the same filesystem-native thread.

## Decisions

### Use the official SDK more completely; do not replace ACP

Copse already depends on `@agentclientprotocol/sdk` and uses its typed client,
agent, method, schema, and NDJSON-stream surfaces. There is no SDK rewrite to do.
The missing layer is durable product state and lifecycle policy, which no wire
SDK can own.

We should nevertheless adopt the SDK more consistently:

- Put all lifecycle calls behind one `AcpSessionLifecycle` adapter and use SDK
  methods/types rather than local JSON-RPC method strings.
- Record the negotiated protocol version and capability snapshot returned by
  initialization; make lifecycle decisions from that snapshot.
- Use the SDK's session list/load/resume/close/delete surfaces rather than
  duplicating their request schemas.
- Add a loopback conformance suite using the SDK on both sides. Keep focused
  fakes for failure injection and capability combinations.
- Use SDK-provided HTTP/WebSocket transports if remote ACP adopts them. Custom
  process spawning, SSH, sandboxing, MCP/native-tool forwarding, transcript
  persistence, and UI reconciliation remain Copse responsibilities.
- Stay on ACP v1 while the TypeScript SDK is v1-only. When it publishes v2
  types, add a negotiated v2 adapter; do not hand-roll a parallel v2 schema.

Adopting separate Codex, Claude, Gemini, and Cursor SDKs for continuation would
fragment behavior and make custom ACP agents second-class. A provider-native
backend remains reasonable only for a feature ACP cannot represent, not as the
session-continuity foundation.

### Keep Copse's transcript and the ACP session distinct

The external agent session is the execution context; the Copse thread spine is
the user-visible record. Reattaching agent memory does not prove that the Copse
transcript contains every turn. The UI must not silently imply otherwise.

- A resume without replay may continue agent memory but leave external turns
  absent from Copse. Mark that state as **continued, transcript incomplete**.
- A load/replay imports history with ACP provenance and conservatively
  reconciles it with existing thread events.
- Never replay a prompt after an ambiguous transport failure. Resume on the next
  user action so a tool call or prompt cannot execute twice.
- Never guess a session from `session/list`. Automatic continuation requires an
  exact stored binding; attaching a different or externally created session is
  an explicit user action.

### Persist an ACP binding beside the thread

Add a private, versioned `acp-session.json` sidecar to the filesystem thread
directory, analogous to `agent-history.json`. Do not add the binding to renderer
thread metadata: it is operational state, should fail closed independently, and
must not be included accidentally in exported chat content.

Illustrative shape:

```json
{
  "v": 1,
  "agentId": "codex",
  "sessionId": "opaque-agent-session-id",
  "protocolVersion": 1,
  "executionTarget": { "kind": "local" },
  "workspaceIdentity": "/absolute/workspace/root",
  "agentConfigGeneration": 3,
  "createdBy": "copse",
  "lastAttachedAt": 1785430800000
}
```

Requirements:

- Write atomically immediately after `session/new`, `session/resume`, or
  `session/load` succeeds and before the first new prompt.
- Treat unknown versions, malformed data, a different workspace, execution
  target, or agent configuration generation as requiring explicit recovery.
- Keep the binding after ordinary shutdown or an unavailable remote host. Clear
  it only on confirmed session-not-found, explicit start-fresh/delete, or thread
  deletion.
- Do not persist environment values, credentials, native-bridge tokens, or MCP
  bearer tokens. Do not derive a durable hash from secret values. Store a
  monotonic agent configuration generation instead.
- Redact raw session IDs from logs, telemetry, transcript events, and exports.
  Audit events may contain a one-way install-scoped identifier.
- An SSH binding also includes the stable remote-host identity and remote cwd;
  it must never resume against a different host merely because the command
  matches.

App shutdown releases transports without sending `session/close`: closing a
durable agent session would defeat later continuation. Close/delete are explicit
user or lifecycle actions.

## Copse-as-client state machine

For a thread with a live connection, keep the current pool reuse. For a durable
binding, select the first supported safe path:

| Situation                                       | Action                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| Exact binding; `session/resume` supported       | Resume the stored ID without replay.                                                |
| Resume rejected; `session/load` supported       | Load the stored ID and reconcile replay.                                            |
| Exact binding; load supported but resume is not | Load and reconcile (the expected Cursor path in the current probe).                 |
| No binding; list and load/resume supported      | Offer an explicit session picker; never auto-select.                                |
| Session missing or incompatible                 | Preserve a diagnostic, start new only after a clear user-visible fallback decision. |
| Neither resume nor load supported               | Create a new session and use the existing Copse-history preamble fallback.          |

The ordering is policy, not a vendor test. Live capability probes currently show
different combinations among Claude, Codex, and Cursor; Gemini, Claude Code ACP,
and each custom command must be probed at the installed version before claiming
continuity support.

Every attach supplies current cwd, additional directories, MCP servers, and
client capabilities. Sessions created in another client may have used different
tools or permissions, so an import must show that provenance and must not imply
that earlier tool calls ran under Copse's sandbox or approval policy.

### Replay and reconciliation

`session/load` notifications arrive in replay mode before normal interaction.
Buffer and normalize them before mutating the thread spine.

1. Prefer stable ACP message/tool identifiers when the negotiated protocol
   provides them.
2. For v1 updates without durable IDs, use ordered content hashes plus role and
   event kind only to deduplicate an exact prefix; never merge merely similar
   messages.
3. Append unmatched events with `source: acp-import` and agent/session
   provenance. Keep the raw session ID only in the private sidecar.
4. If replay is partial, reordered, or cannot represent prior tool activity,
   import what is unambiguous and retain the incomplete-transcript marker.
5. If another client has written since Copse's last attach, require a reload or
   explicit continue-with-gap choice before sending another prompt. ACP v1 has
   no portable multi-writer merge contract.

ACP v2 replaces load with resume plus a replay cursor. The reconciliation layer
therefore accepts an abstract replay stream and cursor rather than depending on
the v1 method name.

## Copse-as-agent durability

`copse --acp` currently has one process-level history and ephemeral random
session IDs. Replace that with one durable Copse thread per ACP session:

- `session/new` creates a filesystem-native thread and a stable session-to-thread
  mapping.
- `session/resume` opens `agent-history.json` and continues without replay.
- `session/load` streams canonical thread history, then makes the session active.
- `session/list` reads the project catalog and filters by cwd/project where the
  request permits.
- `session/close` cancels active work and releases process resources but
  preserves the thread.
- `session/delete` removes the ACP session through the normal thread deletion
  policy; it is not an alias for close.

The GUI and an ACP process may otherwise write the same thread concurrently.
Before exposing shared sessions, add a process-safe per-thread writer lease with
owner, heartbeat, and stale-owner recovery. A second writer gets a structured
busy response or read-only history; it never appends concurrently. The append
spine remains the transcript source, while `agent-history.json` remains the
built-in Copse agent's resumable model history.

Client compatibility is protocol-based. Certify the official SDK loopback first,
then every external ACP client Copse documents or ships an integration for. Add
a client to the advertised matrix only after its list/load/resume behavior has a
saved probe; arbitrary conforming clients use the same methods without a
client-name branch.

## Delivery plan

### Phase 0 — Contracts and conformance harness

- Introduce the lifecycle adapter and a pure capability-to-action decision
  function.
- Replace remaining local lifecycle method strings with SDK methods.
- Extend the saved capability report to exercise stateful new/list/resume/load/
  close behavior, not only advertised booleans.
- Record installed command/version with results. Capability observations expire
  when that version changes.

### Phase 1 — Durable exact-session continuation

- Add the sidecar codec and atomic thread-store operations.
- Inject the store into `acp-session-pool`; load a binding after process start.
- Implement resume-first, load-fallback acquisition and confirmed-stale handling.
- Preserve bindings across idle reap, drop, app shutdown, and SSH unavailability.
- Ship automatic same-thread restart continuation without a new picker.

This phase delivers the central promise for agents that can resume or load while
keeping the existing history-preamble fallback for all others.

### Phase 2 — Replay reconciliation

- Add replay mode to the update adapter.
- Normalize, deduplicate, and append imported messages/tool events.
- Persist replay provenance and incomplete/diverged state without raw session
  IDs.
- Cover load-only agents and external activity between Copse attaches.

### Phase 3 — Cross-client session discovery

- Add `session/list` behind an explicit **Continue ACP session…** action.
- Filter by selected agent, execution target, and workspace; show timestamps and
  titles but do not infer equivalence from cwd alone.
- Add **Start fresh**, **Reload external history**, and supported close/delete
  actions with capability-aware copy.
- Show connected, imported, unavailable, and transcript-incomplete states.

This is a visible renderer change and requires component coverage plus a focused
WebdriverIO visual eval and screenshot.

### Phase 4 — Durable `copse --acp`

- Replace global history with per-session thread-backed state.
- Implement durable new/list/load/resume/close/delete through the SDK agent
  surface.
- Add the cross-process writer lease.
- Let the Copse GUI open a thread created through ACP and vice versa.
- Run external-client compatibility probes and document only verified clients.

### Phase 5 — ACP v2

- Upgrade when the official TypeScript SDK publishes v2 types.
- Add a versioned lifecycle implementation using resume plus `replayFrom`.
- Keep v1 negotiation and tests for installed v1-only agents.
- Follow the broader adapter and permission changes in
  [`../acp-v2-readiness.md`](../acp-v2-readiness.md).

## Verification

Unit and integration coverage comes before end-to-end UI coverage:

- Decision-table tests for every capability combination and fallback.
- Sidecar tests for atomic writes, corrupt/future data, redaction, config
  generation, workspace mismatch, and local/SSH target mismatch.
- Pool tests that recreate the pool/store to simulate a real app restart.
- Fake-agent scenarios for resume, load-only, expired sessions, drop after
  prompt acceptance, replay duplicates, partial replay, and external writes.
- SDK loopback tests that create a session, destroy both connections, recreate
  them, then list/load/resume and continue.
- Copse-agent tests that restart the serving process abstraction and recover a
  real filesystem thread.
- Versioned Tier-1 probes for every built-in ACP preset; custom agents report
  negotiated support rather than receiving an optimistic badge.
- Phase 3 component tests and one focused Electron visual eval for discovery,
  imported-history warning, and unavailable-session states.

During implementation, run focused ACP/thread-store tests and the test oracle;
run `npm run check` before each commit. Run build/e2e only for the real-runtime or
visible phases that require them.

## Acceptance criteria

- Closing and reopening Copse continues an exact Claude or Codex ACP session
  without replaying the last prompt.
- A load-only agent continues through replay without duplicating visible turns.
- Returning after using the same agent session in another client either imports
  the intervening turns or clearly reports that the transcript is incomplete.
- A Copse ACP session can be listed and continued by a supported external client
  after `copse --acp` restarts, and the same thread opens in the Copse GUI.
- No automatic session selection crosses agent, workspace, or execution-target
  boundaries.
- No credential, environment value, native bridge token, or raw session ID
  appears in logs, telemetry, or exported transcripts.
- No transport-recovery path can duplicate a prompt or tool execution.
- Unsupported/custom agents retain a correct new-session plus Copse-history
  fallback and display their negotiated limitation.

## Non-goals

- Migrating a conversation between different agent implementations.
- Concurrent multi-writer transcript merging in the first release.
- Reconstructing tool details an agent does not replay.
- Implementing ACP v2 ahead of the official TypeScript SDK.
- Replacing ACP with provider-specific agent SDKs.

## Relationship to existing plans

This document owns durable continuation, discovery, replay, and Copse's durable
ACP-agent role. It supersedes the session-store/resume portions of
[`acp-client-support.md`](acp-client-support.md). SSH transport remains owned by
[`acp-over-ssh.md`](acp-over-ssh.md), and protocol-v2 migration remains owned by
[`../acp-v2-readiness.md`](../acp-v2-readiness.md).
