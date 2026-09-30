# ACP session continuity

Status: **In progress.** The changed-working-directory carry-over is implemented
(see [below](#changed-working-directory)). The durable binding, replay
reconciliation, discovery, and `copse --acp` phases are still proposed.

Date: **2026-07-30**, updated **2026-09-26**

## Outcome

An ACP conversation should survive an idle reap, agent-process failure, a
restart into a **different working directory**, Copse restart, and an
intentional hand-off to another ACP surface. Returning to the same Copse thread
should reconnect to the same agent session when possible and must accurately
represent any history that Copse cannot display.

The changed-directory case comes first. Deferred thread worktrees
(`claude/threads-no-workspace-prototype-cef7d7`,
`docs/plans/deferred-thread-worktrees.md` on that branch) start a thread without
a worktree and create one only when the agent first needs to write. Native Copse
threads can switch roots mid-turn. An ACP agent cannot: its cwd and OS sandbox
are fixed when its process starts and its session is created. The planned ACP
flow starts the agent read-only, exposes a `request_write_access` tool through
the native MCP bridge, creates the worktree, and then restarts the agent in it.
That last step is acceptable only if the conversation comes along.

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

## Changed working directory

### Evidence

`npm run probe:acp -- --continuity` restarts each agent, reattaches from the
same or a different directory, and asks for a codeword planted before the
restart ([method](../acp-capability-probe.md#session-continuity-trials-npm-run-probeacp----continuity),
[results](../acp-support-findings.md#session-continuity-across-a-restart-and-a-new-cwd-2026-09-26)).
On 2026-09-26:

| Agent                   | load, same cwd | load, new cwd | resume, same cwd | resume, new cwd |
| ----------------------- | -------------- | ------------- | ---------------- | --------------- |
| Claude Agent ACP 0.70.0 | ✓              | ✓             | ✓                | ✓               |
| Codex ACP 1.6.2         | ✓              | ✓             | ✓                | ✓               |

Not probed: Cursor (`cursor-agent acp` required authentication on the probe
host; it advertises `loadSession` only), and the retired Zed `claude-code-acp`
(renamed upstream to Claude Agent ACP).

Each new-cwd success held across a second restart in the new directory. After
the move, each agent reported the new directory as its cwd. The hypothesis that
Claude would lose a session filed under another directory is half right. Claude
does store transcripts per directory, but it finds a session by id from any
directory and keeps appending to the original project's file. Codex behaves the
same from Copse's point of view.

### Decisions

1. **A session outlives its process.** The pool used to key reuse on one
   fingerprint that includes cwd, sandbox, permission mode, and MCP servers. Any
   change to it discarded the agent session. The fingerprint still decides
   whether the **process** can be reused. A narrower **lineage** (command, args,
   env, and SSH host) decides whether a new process may take over the
   **session**. Cwd, sandbox, permission mode, and MCP servers are all supplied
   again when the session is reattached (`session/load`/`resume` carry `cwd` and
   `mcpServers`, and the mode is reapplied after attach). Changing them costs a
   process, not the conversation. A different agent or host never inherits a
   session.
2. **Same directory: resume, then load.** Resume restores memory without
   replay. Load is the fallback, and it is the only path for load-only agents
   such as Cursor. This implements the first rows of the
   [state machine](#copse-as-client-state-machine) for in-process restarts
   (idle reap, dropped transport, fault replacement, and a mode or sandbox
   change).
3. **New directory: load only, and it must prove itself.** An agent that files
   sessions per directory could answer a resume from the new one with an empty
   session and no error. Resume replays nothing, so Copse could not tell
   continuation from a silent reset. Load replays the conversation before it
   returns, so after a move Copse requires the replay to contain at least one
   user message whenever the old session had been prompted. Otherwise the load
   counts as `history-missing`. The probe shows resume across directories
   working for both adapters above. That is evidence about two adapter versions,
   not a protocol guarantee, and both of them can also load. Revisit this if an
   agent that can only resume matters.
4. **Drop the load replay; do not import it.** When Copse reattaches a session
   it drove itself, the replay is the conversation already in the thread. It is
   counted, used as proof, and discarded before the update pump sees it.
   Otherwise the pump would render the whole thread again as new output. State
   updates that arrive with it (commands, mode, config options, title) still
   apply. Importing replay remains Phase 2's job, for sessions that another
   client also wrote to.
5. **One writer.** The old process is disposed before the new one reattaches.
   Two processes never hold one agent session.
6. **When it cannot carry over, say what was lost.** The new session receives
   the existing Copse-transcript preamble, which contains user and assistant
   text only. The turn opens with a note, sent through the caller's sink so it
   never enters the model history replayed into later turns. The note names the
   cause (`moved-without-load`, `unsupported`, `rejected`, `history-missing`)
   and states that the agent's earlier tool calls and their output, the files it
   read, and its reasoning did not carry over. It is emitted only when the lost
   session had been prompted. It is not emitted when the user switches agents,
   which is a hand-off to someone else rather than a loss. It is also not yet
   emitted after a Copse restart, because nothing binds the thread to its old
   session until the [sidecar](#persist-an-acp-binding-beside-the-thread) lands.
   Visual evidence: `tests/e2e/acp-session-handover.e2e.ts`.

### What the deferred-worktree flow must do

The carry-over happens when the pool acquires a session at a turn boundary. The
`request_write_access` tool should therefore:

1. create the worktree and return a tool result telling the agent it will
   continue in that directory with write access;
2. let the prompt settle, ending the turn rather than killing the process under
   it (decision 5);
3. start the continuation turn under the worktree's execution context, with the
   relaxed sandbox and permission mode. The pool then respawns the agent there
   and loads the same session.

If the agent cannot load (a custom agent, or a failed load), that continuation
turn opens with the handover note, and the agent works from Copse's transcript.

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

Within one Copse run, the first three rows are implemented for every in-process
restart, and the last row is implemented with an honest handover note (see
[Changed working directory](#changed-working-directory)). Across a Copse restart
there is no binding yet, so today every thread takes the last row.

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

### Phase 0.5 — Changed-directory carry-over (implemented)

- Split the pool's process fingerprint from the session lineage; carry the
  session over on any same-lineage respawn.
- Same cwd: resume, then load. New cwd: load, verified by its replay.
- Drop the load replay before the update pump sees it.
- Report `AcpSessionHandover` to the turn, and open the turn with a note that
  says what did not carry over.
- `npm run probe:acp -- --continuity`, which adds the observed _Resume in new
  cwd_ capability to the support matrix.

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

Changed-directory carry-over (Phase 0.5) is covered by:

- `acp-session-continuity.test.ts`, which runs the real pool and client
  against a fake agent whose session store outlives each process. It covers
  load into a new cwd (no replay rendered, memory kept, commands applied); a
  later idle reap in the new cwd; a mode-only change resuming in place;
  load-only reattach after a reap; the move without load, refused load, and
  empty-replay handovers; nothing reported when the old session was never
  prompted; and no session crossing to another agent.
- `acp-session-reattach.test.ts` for the method order, the replay split, and
  the note copy.
- `acp-continuity-probe.test.ts` for the probe against global, per-cwd, and
  silently-empty per-cwd storage.
- `acp-capability-probe.test.ts` for the matrix rows.
- `tests/e2e/acp-session-handover.e2e.ts` and its screenshot for the note.

Still to cover in later phases:

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
- A thread whose ACP agent restarts in a different working directory keeps its
  agent session when the agent can load it there (Claude and Codex today), and
  otherwise says in the thread what did not carry over.

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
