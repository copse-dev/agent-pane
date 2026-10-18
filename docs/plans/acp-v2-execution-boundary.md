# ACP v2 and the Copse execution contract: where the boundary goes

Tracking: [#1079](https://github.com/copse-dev/agent-pane/issues/1079) (headless contract),
[#264](https://github.com/copse-dev/agent-pane/issues/264) (ACP)

Status: **Proposed, needs a decision.** This is a design record. It changes no code. It
revises claims in [`headless-automation-contract.md`](headless-automation-contract.md),
[`../acp-v2-readiness.md`](../acp-v2-readiness.md),
[`acp-session-continuity.md`](acp-session-continuity.md),
[`background-supervisor.md`](background-supervisor.md),
[`cross-device-harness-offload.md`](cross-device-harness-offload.md),
[`deferred-approvals.md`](deferred-approvals.md) and
[`codex-oss-architecture-comparison.md`](codex-oss-architecture-comparison.md) (P3). Those
edits are marked _Proposed revision (2026-10-16)_ in place.

## Decision

Treat **ACP v2 as the reference for session and message semantics**: prompt acceptance,
message and tool upserts, foreground state, cancellation, permission prompts, resume and
replay. Narrow the Copse contract to what ACP deliberately leaves out: **execution**
(submission dedupe, policy profile, budgets, writer ownership, delivery target, expected
artifacts and task outcome). The **thread store stays authoritative**, and ACP wire types
never become storage types.

**Do not ship v2 by default yet.** Upstream labels v2 a draft ("Don't ship it by default in
production"). Do the version-independent groundwork now, and turn v2 on per agent behind a
flag (stage S4).

Rejected alternative: grow the general Copse contract into a full Thread/Turn/Item protocol
and treat ACP as one adapter of it (option 2 below). Reopen it only if stage S1 produces the
evidence listed under [What would change this](#what-would-change-this).

## Upstream state (checked 2026-10-18)

| Item              | State                                                                                                                                                                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema            | [`v2.0.0-alpha.9`](https://github.com/agentclientprotocol/agent-client-protocol/releases) (prerelease, 2026-10-16). Nine alphas since July, about weekly since alpha.7. Recent alphas pin down rules (prompt insertion #2392, foreground transitions #2411, cancellation #2390, replay ids #2398) rather than add features. |
| TypeScript SDK    | npm `latest` 1.9.0. v2 is only at `./experimental/v2`. 1.9.0 decoupled session updates from prompt completion (typescript-sdk #280). `main` locks **1.7.0**.                                                                                                                                                                |
| Shipping agents   | `claude-agent-acp` 0.92.0 serves v2 behind `CLAUDE_AGENT_ACP_EXPERIMENTAL_V2=1`. Zed `main` compiles the Rust crate with `unstable_protocol_v2` (runtime use unverified). `codex-acp` pins a pre-v2 crate.                                                                                                                  |
| Shipping in Copse | Nothing. The v2 prototypes (`acp-v2-session-adapter.ts` and the dual-version arm of `acp-v2-conformance.test.ts`) are exercised only by tests. The client and session pool always negotiate v1, and the headless contract's `negotiateProtocolVersion` has no production caller.                                            |

Primary sources: [v2 overview RFD](https://agentclientprotocol.com/rfds/v2/overview.md),
[prompt lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle.md),
[v2 prompt RFD](https://agentclientprotocol.com/rfds/v2/prompt.md),
[resume and replay RFD](https://agentclientprotocol.com/rfds/v2/session-resume-replay.md),
[draft announcement](https://agentclientprotocol.com/announcements/acp-v2-draft.md).

What v2 does **not** promise, in its own words:

- Agents "are not required to persist every inserted user message".
- The prompt's returned id "is an acknowledgment, not a client-supplied idempotency key".
- Clients "MUST NOT rely on" agent or thought message ids to deduplicate replay. Only user
  message ids must stay stable.
- There is no turn id. The prompt RFD asks "Does the returned ID identify a turn…?" and
  answers "No". The SDK client API adds: "an idle `state_update` does not establish that
  this message was processed."
- There is no ownership, multi-writer or task concept, and permission requests are
  connection-scoped with no durable deferral.

## Ownership matrix

| Concept                                | ACP owns                                                            | Copse owns                                                                                                    | Adapter does                                                                                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session identity                       | `sessionId` (opaque, minted by the agent)                           | Thread id                                                                                                     | Maps one to the other in the `acp-session.json` binding (which has no production callers yet)                                                                                                                          |
| Turn identity                          | None. Only the running → idle interval                              | Turn tree / operation id, internal only                                                                       | Anchors outcomes on the **user `messageId`**. A Copse turn id goes on the wire only under `_meta["copse.dev"]`, if at all                                                                                              |
| Prompt acceptance                      | `{ messageId }` once the message is inserted                        | As agent, the spine user message id **is** the `messageId`. As client, the agent's id is stored as provenance | As agent, `copse --acp` answers on insertion, not at end of turn                                                                                                                                                       |
| Foreground completion                  | `idle` + `stopReason` (6 values)                                    | `TurnOutcome` (richer: `context_overflow`, `timeout`, `tool_denied`, …)                                       | One mapping table: the coarse ACP reason on the wire, the exact Copse reason in `_meta["copse.dev"].stopReason`. Maps back losslessly when that key is present                                                         |
| Task completion and delivery           | Absent                                                              | Supervisor task state, delivery outcome (pushed, PR opened), artifact references                              | None. This is the execution contract                                                                                                                                                                                   |
| Message and tool updates               | Upserts keyed by type + id; chunks append; field-level tool patches | Spine message lines (upsert by id); finished tool calls                                                       | Folds by id. Needs an internal **replace-message-by-id** chunk: `text_replace` means "replace the current message", so per-id upserts squeezed through it collapse messages (measured below)                           |
| Replay and reconnect                   | `session/resume` + `replayFrom` (`{type:"start"}` only)             | **Durable retention** in the thread store                                                                     | Imports with ACP provenance. Deduplicates by user `messageId` only. Replay goes through the upsert fold, never the append path                                                                                         |
| Submission dedupe                      | Absent                                                              | Idempotency key on the execution request (the supervisor's dedupe key / operation id)                         | Never re-sends a prompt after an ambiguous failure                                                                                                                                                                     |
| Cancellation                           | Cancels foreground work → `idle(cancelled)`                         | Cancelling a task, with the existing terminal fence                                                           | An ACP cancel aborts the foreground turn only. It cancels a supervised task only if Copse policy says so                                                                                                               |
| Permission **decision**                | —                                                                   | The existing permission gate. It is the only authorization engine                                             | —                                                                                                                                                                                                                      |
| Permission **prompt and answer**       | `session/request_permission`, `requires_action`                     | —                                                                                                             | Presentation only. Picks options by `kind`, never by agent-defined id. `cancelled` or an unknown outcome is never approval. An external `allow_always` becomes a remembered grant only if Copse's own policy allows it |
| Durable deferral                       | Absent                                                              | Deferred approvals (`defer`)                                                                                  | With no client attached, Copse defers and reports `requires_action`. On resume, re-issues the request from the defer queue                                                                                             |
| Version negotiation                    | Per connection; to fall back, reconnect                             | Execution contract: one integer, rejected on mismatch (as in [`../api-protocol.md`](../api-protocol.md))      | No third negotiation scheme                                                                                                                                                                                            |
| Durable execution ownership            | Absent                                                              | Fenced per-thread writer lease (owner, epoch, heartbeat)                                                      | A second attachment is read-only or gets a structured busy error                                                                                                                                                       |
| Policy, sandbox, budgets, capabilities | Session capabilities only                                           | Profiles, sandbox state, budgets                                                                              | `_meta["copse.dev"]` or a `_copse/*` method if a client needs them                                                                                                                                                     |

**What stays authoritative in the thread store:** the transcript, turn outcomes, permission
decisions and deferrals, and ACP provenance (agent session id, agent message ids). ACP state
(`running`, `idle`, `requires_action`) is **derived** from Copse's turn and gate state and
never stored. That is how this avoids a second state machine. The adapter never decides a
permission, which is how it avoids a second authorization engine.

**How to avoid lossy conversions:** every projection (ACP v1, ACP v2, the frozen headless
event envelope) is checked by a round trip, spine → wire → fold → spine. It must come back
equal, apart from a written list of fields carried only in `_meta["copse.dev"]`.

## Options compared

|                           | (1) ACP v2 externally + a narrow execution contract (**proposed**)                                                                                                                                                                                        | (2) The general Copse contract, with ACP as an adapter                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What Copse defines        | Execution request (policy profile, budgets, idempotency key, ownership, expected artifacts, delivery target) and execution outcome (task state, delivery, artifacts, exact stop reason)                                                                   | All of that, **plus** item upserts, replay cursors, cancellation, approval answers, deferral, negotiation and a transport (the `codex-oss-architecture-comparison.md` P3 protocol) |
| Migration cost            | Medium. Mostly unavoidable: Copse is an ACP **client** of Claude, Codex and others whichever option wins, so the v2 client adapter has to be built anyway                                                                                                 | Higher: the same v2 client adapter, **plus** a parallel protocol and two mappings (Copse↔v1 and Copse↔v2)                                                                          |
| v1 and existing consumers | v1 stays while agents speak it. `copse-review --events` and bench `.headless.jsonl` (the only external consumers of the event envelope) are frozen as **v1 CI output**, not a session protocol                                                            | Same consumers, but the envelope keeps growing                                                                                                                                     |
| Security risk             | Shipping a draft, mitigated by a flag and per-agent opt-in. v2 drops client `fs/*`, so Copse can no longer intercept external agents' writes through the diff queue; containment has to come from the agent side. External `allow_always` (handled above) | A second vocabulary for permissions and lifecycle, which is how a second authorization machine starts. Drift from ACP                                                              |
| Operational risk          | Upstream churn until v2 stabilizes. Conformance tests will need rewording as the alphas tighten rules                                                                                                                                                     | Maintaining a protocol nobody outside Copse speaks                                                                                                                                 |
| Advantage                 | No duplicated semantics. External clients work unmodified                                                                                                                                                                                                 | Independent of upstream's pace. Has a turn id                                                                                                                                      |

## Evidence so far

A throwaway exploration (not merged; SDK 1.9.0 in a scratch package, repo lockfile
untouched; 15 tests) measured the round trip. No real model was used: the Claude agent ran
against a local mock of the Anthropic API.

| Arm                                               | Result                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shipping v1 `copse --acp` (SDK 1.7.0)             | **Lossy.** `text_replace` went out as an append, so stripped pseudo-XML reappeared and the prose doubled (#3829 removes the doubling; the markup needs v2). Shell tool names arrived as the command (`"npm test"`), because v1 tool calls have no name field                                           |
| Copse-as-v2-agent sketch, same scripted turn      | **Lossless.** 0 differences across 3 messages, 2 reasoning blocks and 2 gated tool calls, using two `_meta["copse.dev"]` keys (tool → owning message, exact stop reason). All updates validated against the 1.9.0 schemas. `{messageId}` arrived before `idle` and equalled the stored user message id |
| Cancel during an open permission request          | Gate recorded `cancelled`; the tool did not run; nothing became an approval                                                                                                                                                                                                                            |
| Resume + `replayFrom: start` on a new connection  | Nothing imported twice. Replay alone rebuilt the transcript. An unknown cursor was rejected                                                                                                                                                                                                            |
| Existing v2 client prototype (Copse consuming v2) | **Lossy:** drops tool results; revising the first of two messages collapses both into one (`"ONEtwo"`); ignores whole-thought upserts; a tool whose first update is `completed` stays `running`; live updates followed by replay duplicate text                                                        |
| Real `claude-agent-acp` 0.92.0 in v2 mode         | Negotiated v2; one gated Bash turn plus a resume from a fresh process. Ids survived the restart **because Claude Code persists its own session file**, not because ACP requires it. Permission option ids are agent-defined (`allow-once`), so choose by `kind`                                        |
| Narrow execution contract (schemas only)          | Request 25 / outcome 28 properties, overlapping ACP on none, against 43 in today's headless schema. Tests: duplicate idempotency key → one submission; version mismatch rejected; a budget required; unattended `ask` → `deny` or `defer`, never `allow`                                               |

**Conclusion:** every loss measured is in Copse's own adapters, not in ACP. The shared root
cause is that the internal stream has no "replace message _X_" primitive.

**Not covered:** real models; Codex, Gemini and Zed as v2 peers; the real thread store
(writer lease, crash safety, cross-process dedupe); the real renderer (its rules were
modelled); `terminal_update`, `plan_update`, usage, commands, subagents, fork and config
options.

## What would change this

Favours option 2:

1. The S1 round trip finds a concept that consumers need and that has no sensible `_meta`
   home. The likeliest candidate is a turn id for budget accounting.
2. v2 stays in alpha for two or more further schema cycles with breaking changes to the
   rules S1 asserts.
3. The CI consumers need a one-way, file-based format that an ACP ndjson transcript can't
   serve.

Favours option 1:

1. `claude-agent-acp`, `codex-acp` or Zed negotiate v2 in the probe matrix
   (`probe:acp -- --protocol 2`).
2. v2 leaves `./experimental/` (the nightly `acp-v2-watch` detects this).
3. The S1 round trip loses nothing beyond the listed `_meta` fields.

## Staged migration

Each stage is shippable on its own, and nothing before S4 changes what the product
negotiates.

**S0. Fixes that are right under either option.**

- [x] `copse --acp` no longer sends a rewritten message as an append to v1 clients
      ([#3829](https://github.com/copse-dev/agent-pane/pull/3829)). It forwards only an
      extension of what was sent; removing already-sent markup needs v2.
- [ ] `projectStreamChunk` (`packages/agent/src/headless-contract.ts`) drops
      `text_replace`, so the event envelope keeps text the loop later stripped. Emit a
      replacement for the same item.
- [ ] v1 shell tool calls lose their tool name through Copse's own client. Carry the name
      in `_meta["copse.dev"]` and prefer it over the title.

Acceptance: a loopback test where a turn rewrites its text; the client's folded text and the
review/bench JSONL both equal the final spine text.

**S1. The round-trip conformance suite (decides between the options).** Test tier only, with
no product wiring. Needs the SDK pin at ≥ 1.9.0, in its own dependency PR with the full
check. One scripted mock-LLM turn containing several messages (one rewritten), a reasoning
block, a tool call going pending → running → done with replaced content, and a permission
prompt; then a second run with a cancel. Assert:

1. Every emitted update validates against the SDK's v2 schema.
2. Folding the updates by upstream's upsert rules (a spec-literal reference fold)
   reproduces the spine's messages and tool calls exactly, apart from the listed `_meta`
   fields.
3. The prompt response is `{ messageId }`, arrives before `idle`, and equals the spine's
   user message id.
4. A cancel produces `idle(cancelled)`, the pending permission resolves as `cancelled`, and
   the gate records **no** approval.
5. Resume with `replayFrom: start` imports nothing twice (deduplicated by user
   `messageId`).
6. The v2 arm of `acp-v2-conformance.test.ts` awaits the prompt and asserts the
   `messageId` response.

**S2. Replace-message-by-id in the internal stream.** Add an id-keyed replace for text and
reasoning to the chunk vocabulary and the renderer. The S1 fold is its oracle. This fixes
the client-side losses in the table above.

**S3. The narrow execution contract.** Schemas for an execution request and an execution
outcome (accepted → foreground stopped → task terminal), with no event stream, plus a
`defer` resolution. Conformance: an unattended `ask` resolves to `defer` or `deny`, never
`allow`; a duplicate idempotency key does not create a second submission; a version
mismatch is rejected. The writer lease and the thread-backed `copse --acp` remain Phase 1
and Phase 4 of [`acp-session-continuity.md`](acp-session-continuity.md); they must land
before any multi-client attach is advertised.

**S4. v2 behind a flag, per agent.** Wire the v2 client adapter into the session pool for
agents that serve v2 (`claude-agent-acp` first), and add a v2 handler to `copse --acp` on
the existing `AcpTurnContext` seam. It answers `session/prompt` on insertion and carries
Copse-only data in `_meta["copse.dev"]`. Validate with a real authenticated model run, not
only the mock. Default-on waits for v2 to leave `./experimental/`.
