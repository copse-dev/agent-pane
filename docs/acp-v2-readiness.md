# ACP v2 readiness

**Short answer: the capability probe (and all of Copse's ACP integration) is
v1, by design. ACP v2 is an unstable draft that no shipping agent speaks yet, so
there is nothing to probe today — but it is a large breaking change, so this
page tracks what's coming and where it will land.**

## Why the probe can't (and shouldn't) see v2 today

Three independent facts, all verifiable in the pinned SDK
(`@agentclientprotocol/sdk@0.29.0`):

1. **The SDK is v1.** `PROTOCOL_VERSION === 1`; there are no v2 types in the
   package. The probe requests v1 in `initialize`.
2. **Version negotiation downgrades.** A client asks for a version and the agent
   answers with one it supports (≤ requested). A v2-capable agent talking to our
   v1 request answers **v1**. So we never receive v2 shapes.
3. **Unknown fields are stripped.** Incoming notifications are zod-parsed
   (`zSessionNotification.parse`) against a v1-only union, and zod v4 strips
   unknown keys. Even if a v2 field leaked through, it would be dropped before
   our code saw it — an unknown `sessionUpdate` kind (e.g. `state_update`) fails
   the v1 union outright.

So "does the probe cover v2?" is really "should a v1 client synthesize v2
data?" — no. v2 is **opt-in, off by default, explicitly unstable** per the
[v2 overview RFD](https://agentclientprotocol.com/rfds/v2/overview). It's a
future migration of the whole integration, not a hole in the probe.

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

1. Bump the SDK to a version that publishes v2 types (opt-in/unstable).
2. Add a v2 branch to `extractCapabilitySnapshot` reading the new `capabilities`
   / `info` shape, and probe with `--protocol 2`. Keep the v1 path — agents will
   speak both for a long transition.
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
