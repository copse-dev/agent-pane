# ACP v2 readiness

**Short answer: the capability probe (and all of Copse's ACP integration) is
v1, by design. The _protocol_ project is well into v2, and as of SDK **1.3.0**
the TypeScript SDK we consume publishes a v2 API too — but on a separate
`./experimental/v2` entry point that Copse deliberately does not import. Its
main entry, the one our client is built on, still negotiates v1. This page
tracks what's coming, how far along it is, and where it lands.**

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
- **The published TypeScript SDK (`@agentclientprotocol/sdk`) ships v2 behind
  an experimental entry point.** Latest is **1.3.0** (`latest` tag; the 0.29→1.x
  jump is v1 going _stable_, not v2). Its **main** entry is unchanged —
  `PROTOCOL_VERSION === 1`, generated from `schema/schema.json` — but 1.3.0 added
  a second export, **`@agentclientprotocol/sdk/experimental/v2`**, whose
  `PROTOCOL_VERSION` is **2**, generated from the shipped
  `schema/v2/schema.unstable.json`. Note how it arrived: a **minor** release, no
  major bump and no `next` dist-tag — a watch that only looked for those two
  shapes would have missed it entirely (see [The watch](#the-watch-how-well-find-out)).
  The Rust crate isn't published to npm at all (`@agentclientprotocol/schema`
  404s), so the JSON schema reaches us only through the SDK.

**Net:** v2 is now _reachable_ from the SDK we already install, but it is
explicitly experimental, and adopting it is the migration below — a rewrite of
the session-update adapter, the permission bridge, and the write path — not an
import change. So **v2 stays a watch item**, with the trigger sharpened: not
"when does the SDK gain v2 types" (it has them) but **when does v2 leave
`./experimental/`**, or start being what the main entry negotiates. That
tracking is automated rather than a periodic manual re-check of npm; see
[The watch](#the-watch-how-well-find-out) below.

> `package.json` depends on `@agentclientprotocol/sdk@^1.3.0` (locked `1.3.0`).
> The unit gate pins both halves of what that version means
> (`scripts/acp-v2-watch.test.ts`): the main entry is `PROTOCOL_VERSION === 1`,
> and `./experimental/v2` is `PROTOCOL_VERSION === 2`.

## Why the probe can't (and shouldn't) see v2 today

Three independent facts, all verifiable in the SDK we depend on
(`@agentclientprotocol/sdk@1.3.0`):

1. **The code path we use is v1.** The probe, the client, and every adapter
   import the package's main entry, where `PROTOCOL_VERSION === 1`, and the
   probe requests v1 in `initialize`. The v2 types that 1.3.0 also ships live on
   a separate `./experimental/v2` entry point nothing in `src/` imports, so they
   are not reachable from any current code path — importing them is the
   migration, not a switch.
2. **Version negotiation downgrades.** The client sends the latest version it
   supports; the agent answers with the same version or its own latest. To use
   v2 a client must send `protocolVersion: 2` — which the v1 entry point we
   build on does not — so a v2-capable agent answers **v1** and we never receive
   v2 shapes. (This is exactly the mechanism the `--protocol` hook targets.)
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
mildly useful telemetry. Probing v2 for real needs the `./experimental/v2`
entry point wired into the probe alongside `--protocol 2` (plus a v2 branch in
`extractCapabilitySnapshot`) — the types exist now, so this is a piece of work
rather than a wait.

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

## The watch: how we'll find out

Nothing above changes until someone notices an upstream publish, and "someone
re-checks npm" is not a mechanism — 1.3.0 shipped a v2 entry point and nobody
here noticed for weeks. Two checks now carry it:

- **Nightly** — [`.github/workflows/acp-v2-watch.yml`](../.github/workflows/acp-v2-watch.yml)
  runs `npm run watch:acp-v2` ([`scripts/acp-v2-watch.mts`](../scripts/acp-v2-watch.mts)).
  Its primary signal is the published package's **export map**, read from the
  registry's `latest` manifest, because that is how v2 actually arrived. It goes
  red when the v2 surface differs from the one already triaged — above all when a
  v2 entry point appears **outside `./experimental/`**, which is v2 graduating —
  and also on a release with major >= 2, a dist-tag beyond `latest`, or our own
  `package.json` moving past the 1.x line. The report (including every v2 entry
  point currently published) goes to the run summary. It is advisory: its own
  workflow, never a merge gate, no build and no dependency install (the script is
  deliberately dependency-free).
- **Every PR** — [`scripts/acp-v2-watch.test.ts`](../scripts/acp-v2-watch.test.ts)
  pins the offline half in the normal unit gate against the SDK actually
  installed: the main entry is `PROTOCOL_VERSION === 1`, `./experimental/v2` is
  `PROTOCOL_VERSION === 2`, and `package.json` still tracks the 1.x line. Either
  number moving fails the gate, which is the point — that change is the migration
  below, not a dependency bump.

What the watch deliberately does **not** do: it reads the npm registry, not the
upstream repo's git HEAD (`agentclientprotocol/typescript-sdk`), so v2 work lands
in git before this sees it; and it exercises no ACP code — Copse's ACP unit tests
run in the normal gate on every PR, and the agent probes (`npm run probe:acp*`)
need real installed agents and stay manual.

When it fires, triage before bumping: confirm what the new surface actually
negotiates. If the migration will take longer than a night, add the new
`kind:name` to `ACKNOWLEDGED` in `scripts/acp-v2-watch.mts` with the reasoning —
the watch keeps reporting the surface and stops going red for a decision already
made.

## When v2 stabilizes — the plan

1. Import the v2 entry point. The types are already installed — `1.3.0` ships
   `@agentclientprotocol/sdk/experimental/v2` (`PROTOCOL_VERSION === 2`); the
   open question is whether to build on `experimental/` or wait for it to
   graduate. Version negotiation is per
   connection, so keep the v1 surface — the migration guide is explicit that
   v1-only agents and clients stay common "for some time."
2. Add a v2 branch to `extractCapabilitySnapshot` reading the new `capabilities`
   / `info` shape, and probe with `--protocol 2` (sends `protocolVersion: 2`; a
   v1 agent still answers v1 and the matrix flags the downgrade).
3. Teach `session-update-adapter.ts` the new update kinds (`state_update`,
   whole-message, tool-call upsert, `plan_update`).
4. Revisit permission handling to consume the structured `subject`, and the
   write path now that `fs/*` is gone.

Until then this is a watch item, not a task — an automated one. The probe is
complete for the v1 surface Copse actually speaks.

## See also

- [`docs/acp-capability-probe.md`](acp-capability-probe.md) — the Tier-1 probe.
- [`docs/acp-agents.md`](acp-agents.md) — the v1 client integration.
- [`scripts/acp-v2-watch.mts`](../scripts/acp-v2-watch.mts) — the nightly registry watch.
- [ACP v2 RFDs](https://agentclientprotocol.com/rfds/v2/overview).
