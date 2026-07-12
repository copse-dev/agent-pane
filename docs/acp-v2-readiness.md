# ACP v2 readiness

**Short answer: the capability probe (and all of Copse's ACP integration) is
v1, by design. The _protocol_ project is well into v2 — there is a stable v2
baseline schema, a migration guide, and an active commit stream — but the
_TypeScript SDK we consume_ has not adopted v2 yet, so there is nothing to probe
today. This page tracks what's coming, how far along it is, and where it lands.**

## Where v2 actually stands (dug through the SDKs + schema, 2026-07)

Two different projects, at two very different stages:

- **The schema source-of-truth (`agentclientprotocol/agent-client-protocol`,
  the `@agentclientprotocol/schema` Rust crate + generators) is actively
  building v2.** It generates a **stable v2 baseline** (`schema/v2/schema.json`,
  `"version": 2`) plus an unstable layer (`schema/v2/schema.unstable.json`),
  gated behind a Cargo `unstable_protocol_v2` feature. The v2 Rust modules have
  materially diverged from v1 (e.g. `tool_call.rs` +68%, `content.rs` +41%),
  there's a full `docs/protocol/v2/` doc set + a "Migrating from v1" guide, and a
  steady stream of `feat(unstable-v2)` commits implementing the RFDs (diff
  format, session/load→resume, permission subjects, ID unification, MCP content
  alignment). v2 schema releases have been explicitly enabled. So on the protocol
  side v2 is real and moving, though the guide still says to "gate v2 behind
  explicit version negotiation and feature flags until it stabilizes."
- **The published TypeScript SDK (`@agentclientprotocol/sdk`) — the one Copse
  depends on — is still v1-only.** Latest is **1.2.1** (`latest` tag; the 0.29→1.x
  jump is v1 going _stable_, not v2). Its dist ships `PROTOCOL_VERSION === 1`,
  only `schema/schema.json` (v1), zero v2 types, and there is no v2/`next`
  dist-tag on npm. The Rust crate isn't published to npm at all
  (`@agentclientprotocol/schema` 404s), so the JSON schema reaches us only
  through the SDK.

**Net:** v2 is coming and its shape is now concrete, but we can't _consume_ it
until the TS SDK generates v2 types. Two takeaways for us:

1. **We're behind on the v1 SDK too.** `package.json` pins `^0.29.0`; latest is
   `1.2.1`. Bumping to the stable v1 1.x is an independent, low-risk maintenance
   item worth doing regardless of v2.
2. **v2 stays a watch item** — track when the SDK ships v2 types (or a `next`
   tag), then execute the plan below.

## Why the probe can't (and shouldn't) see v2 today

Three independent facts, all verifiable in the pinned SDK
(`@agentclientprotocol/sdk`, v1 through the current 1.2.1):

1. **The SDK is v1.** `PROTOCOL_VERSION === 1`; there are no v2 types in the
   package. The probe requests v1 in `initialize`.
2. **Version negotiation downgrades.** The client sends the latest version it
   supports; the agent answers with the same version or its own latest. To use
   v2 a client must send `protocolVersion: 2` — which our v1 SDK cannot — so a
   v2-capable agent answers **v1** and we never receive v2 shapes. (This is
   exactly the mechanism the `--protocol` hook targets.)
3. **Unknown fields are stripped.** Incoming notifications are zod-parsed
   (`zSessionNotification.parse`) against a v1-only union, and zod v4 strips
   unknown keys. Even if a v2 field leaked through, it would be dropped before
   our code saw it — an unknown `sessionUpdate` kind (e.g. `state_update`) fails
   the v1 union outright.

So "does the probe cover v2?" is really "should a v1 client synthesize v2
data?" — no. It's a future migration of the whole integration, not a hole in the
probe.

### The forward hook that exists now

`npm run probe:acp -- --protocol <n>` sets the version requested in `initialize`
(default v1). It's wired end-to-end and the report records **requested vs
negotiated** version, flagging a downgrade in the matrix detail. Today, against a
v1 SDK, requesting v2 just shows how each agent negotiates a newer request down —
mildly useful telemetry. The day the SDK gains v2 types, `--protocol 2` is the
one change needed to start probing it (plus a v2 branch in
`extractCapabilitySnapshot`).

## What's in ACP v2 (the incoming surface)

From the [v2 RFDs](https://agentclientprotocol.com/rfds/v2/overview)
(announced in PR
[#1633](https://github.com/agentclientprotocol/agent-client-protocol/pull/1633),
"docs: announce ACP v2 draft"). These are **breaking** and only stabilize in
protocol version 2:

| v2 change                                                                                                                                                         | Touches (Copse)                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **New prompt lifecycle.** `session/prompt` returns `{}` on _accept_, not end-of-turn. Turns decouple from prompts.                                                | `acp-client.ts` turn/stop plumbing, `acp-session-pool.ts`  |
| **New `state_update`** update (`running` / `idle`+`stopReason` / `requires_action`) carries turn end + usage.                                                     | `session-update-adapter.ts`, `acp-turn-usage.ts`           |
| **Whole-message updates** `user_message` / `agent_message` / `agent_thought` (upserts keyed by `messageId`) + chunks.                                             | `session-update-adapter.ts`                                |
| **Single `tool_call_update` upsert** replaces the v1 `tool_call` / `tool_call_update` split; + content chunks.                                                    | `session-update-adapter.ts`                                |
| **Permission requests** get a required `title` + optional structured `subject` tagged union (`tool_call` → `ToolCallUpdate`).                                     | `acp-native-bridge.ts` (title-regex heuristic), approvals  |
| **Client fs/terminal surface removed** — no `clientCapabilities.fs`, `fs/*`, `terminal/*` (auth.terminal stays).                                                  | `acp-client.ts` fs handlers, the diff-queue write path     |
| **Session modes removed;** model/mode state moves to session config options.                                                                                      | `modelSelectorFrom`, `model-options.ts`, probe `modes` row |
| **`session/load` removed;** `session/resume` + optional `replayFrom` cursor covers no-replay and full replay.                                                     | probe `loadSession`/`resume` rows, `acp-session-pool.ts`   |
| **Capability rename/regroup:** single `capabilities` + `info` in initialize; object-shaped support markers; `session.prompt` / `session.mcp`; `session` optional. | `extractCapabilitySnapshot` (all field reads)              |
| **MCP:** SSE transport removed; stdio an explicit `session.mcp.stdio` capability; `type` discriminator required.                                                  | `toAcpMcpServers`, probe MCP rows                          |
| **JSON-RPC 2.0 batching**; domain-specific ID names (`messageId`, `toolCallId`, …).                                                                               | schema-wide                                                |

## Two v2 changes that matter to the "SDK vs ACP" question

Both narrow gaps that earlier favored a direct Claude Agent SDK backend over ACP:

- **Structured permissions.** v2 gives every permission prompt a required `title`
  and a structured `subject` (tool-call subjects carry a `ToolCallUpdate`). That
  directly addresses the v1 complaint that the permission title is unspecified
  free-form (the reason `acp-native-bridge.ts` matches titles with anchored
  regexes). Caveat: the subject references a `toolCallId` and the tool call's
  `rawInput` stays **optional**, so structured _input_ isn't guaranteed — but the
  prompt-copy-vs-tool-state confusion is fixed.
- **Explicit client surface removal.** v2 drops `fs/*` and `terminal/*` from the
  client role. Copse's diff-queue interception of `fs/write_text_file` is a v1
  mechanism; the v2 write-containment story will have to be rethought (and the
  shell-bypass gap noted in `acp-agents.md` doesn't get better on its own).

## When v2 stabilizes — the plan

1. Bump `@agentclientprotocol/sdk` to a version that publishes v2 types (the v1
   1.x bump can happen now, independently). Version negotiation is per
   connection, so keep the v1 surface — the migration guide is explicit that
   v1-only agents and clients stay common "for some time."
2. Add a v2 branch to `extractCapabilitySnapshot` reading the new `capabilities`
   / `info` shape, and probe with `--protocol 2` (sends `protocolVersion: 2`; a
   v1 agent still answers v1 and the matrix flags the downgrade).
3. Teach `session-update-adapter.ts` the new update kinds (`state_update`,
   whole-message, tool-call upsert, `plan_update`).
4. Revisit permission handling to consume the structured `subject`, and the
   write path now that `fs/*` is gone.

Until then this is a watch item, not a task. The probe is complete for what
exists today.

## See also

- [`docs/acp-capability-probe.md`](acp-capability-probe.md) — the Tier-1 probe.
- [`docs/acp-agents.md`](acp-agents.md) — the v1 client integration.
- [ACP v2 RFDs](https://agentclientprotocol.com/rfds/v2/overview).
