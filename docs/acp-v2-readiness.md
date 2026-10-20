# ACP v2 readiness

**Short answer: the capability probe (and all of Copse's ACP integration) is
v1, by design. The _protocol_ project is well into v2, and as of SDK **1.3.0**
the TypeScript SDK we consume publishes a v2 API too — but on a separate
`./experimental/v2` entry point that Copse deliberately does not import. Its
main entry, the one our client is built on, still negotiates v1. This page
tracks what's coming, how far along it is, and where it lands.**

## Status update (2026-10-16)

The section below dates from 2026-07 and is kept as history. Since then:

- **Schema:** `v2.0.0-alpha.9` (prerelease, 2026-10-16), roughly weekly since
  alpha.7 (2026-10-01). Recent alphas mostly pin down normative rules — prompt
  insertion (#2392), foreground state transitions (#2411, #2387), cancellation
  (#2390, #2385), replay ids and unsupported cursors (#2398), failure after
  insertion as `idle` + `stopReason: "error"` (#2281), per-type entity ids (#2332),
  `_meta` patching on upserts (#2372). v2 as a whole is still labelled draft:
  "Don't ship it by default in production."
- **SDK:** `main` locks **1.8.0**; npm `latest` is **1.9.0**, still only at
  `./experimental/v2`. 1.9.0 changed the v2 client lifecycle ("decouple session
  updates from prompt completion", typescript-sdk #280; negotiation #286), so
  behaviour observed on ≤ 1.8 is not a guide.
- **Adoption:** `claude-agent-acp` 0.92.0 serves v2 behind
  `CLAUDE_AGENT_ACP_EXPERIMENTAL_V2=1` (session baseline, resume with replay,
  fork, delete, permissions, terminals, subagents) and was verified to negotiate
  v2 and complete a gated tool turn plus a cross-process resume. Zed `main`
  compiles the Rust crate with `unstable_protocol_v2` (runtime use unverified);
  `codex-acp` pins a pre-v2 crate.
- **Measured round trip:** a throwaway exploration drove a realistic Copse turn
  through v2 and back with zero transcript loss, and measured the losses in Copse's
  own adapters ([results](plans/acp-v2-execution-boundary.md#evidence-so-far)). Finding 3 below and the prompt-lifecycle row are
  corrected by it. The boundary decision it informs is
  [`plans/acp-v2-execution-boundary.md`](plans/acp-v2-execution-boundary.md).

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

> `package.json` depends on `@agentclientprotocol/sdk@^1.8.0` (locked `1.8.0`; 1.9.0 is the first release with the v2 insertion-receipt lifecycle).
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

| v2 change                                                                                                                                                                                                                                                                               | Touches (Copse)                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **New prompt lifecycle.** `session/prompt` returns `{ messageId }` once the user message is _inserted_ (not on receipt, not at end of turn); a JSON-RPC error means it was not inserted. Turn end is `idle`; nothing binds an idle to a particular prompt, and there is **no turn id**. | `acp-client.ts` turn/stop plumbing, `acp-session-pool.ts`  |
| **New `state_update`** update (`running` / `idle`+`stopReason` / `requires_action`) carries turn end + usage.                                                                                                                                                                           | `session-update-adapter.ts`, `acp-turn-usage.ts`           |
| **Whole-message updates** `user_message` / `agent_message` / `agent_thought` (upserts keyed by `messageId`) + chunks.                                                                                                                                                                   | `session-update-adapter.ts`                                |
| **Single `tool_call_update` upsert** replaces the v1 `tool_call` / `tool_call_update` split; + content chunks.                                                                                                                                                                          | `session-update-adapter.ts`                                |
| **Permission requests** get a required `title` + optional structured `subject` tagged union (`tool_call` → `ToolCallUpdate`).                                                                                                                                                           | `acp-native-bridge.ts` (title-regex heuristic), approvals  |
| **Client fs/terminal surface removed** — no `clientCapabilities.fs`, `fs/*`, `terminal/*` (auth.terminal stays).                                                                                                                                                                        | `acp-client.ts` fs handlers, the diff-queue write path     |
| **Session modes removed;** model/mode state moves to session config options.                                                                                                                                                                                                            | `modelSelectorFrom`, `model-options.ts`, probe `modes` row |
| **`session/load` removed;** `session/resume` + optional `replayFrom` cursor covers no-replay and full replay.                                                                                                                                                                           | probe `loadSession`/`resume` rows, `acp-session-pool.ts`   |
| **Capability rename/regroup:** single `capabilities` + `info` in initialize; object-shaped support markers; `session.prompt` / `session.mcp`; `session` optional.                                                                                                                       | `extractCapabilitySnapshot` (all field reads)              |
| **MCP:** SSE transport removed; stdio an explicit `session.mcp.stdio` capability; `type` discriminator required.                                                                                                                                                                        | `toAcpMcpServers`, probe MCP rows                          |
| **JSON-RPC 2.0 batching**; domain-specific ID names (`messageId`, `toolCallId`, …).                                                                                                                                                                                                     | schema-wide                                                |

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
- **Every PR, against a real agent** —
  [`src/main/services/acp/acp-v2-conformance.test.ts`](../src/main/services/acp/acp-v2-conformance.test.ts)
  drives the SDK's own **dual-version example agent** as a subprocess. See
  [Testing against a real agent, for free](#testing-against-a-real-agent-for-free).

What the watch deliberately does **not** do: it reads the npm registry, not the
upstream repo's git HEAD (`agentclientprotocol/typescript-sdk`), so v2 work lands
in git before this sees it. The agent probes (`npm run probe:acp*`) are separate
again — they need real installed, authenticated agents and stay manual.

## Testing against a real agent, for free

Copse's ACP tests used to talk only to Copse. `acp-loopback.test.ts` wires the
product's own agent half (`acp-agent-server.ts`) to its client half over real
ndjson framing, which is a good end-to-end check but cannot catch a _shared_
misreading of the protocol — both ends are ours. Copse can also be spawned as an
ACP agent for real (`--acp` → `runAcpAgentMode`), and with `COPSE_PANEL_MOCK_LLM=1`
that costs no tokens, but it boots inside Electron, so it is e2e-tier.

The third party is already installed. `@agentclientprotocol/sdk` publishes
runnable examples inside its tarball:

| Shipped file                          | What it is                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `dist/examples/dual-version-agent.js` | Answers **v1 or v2** per connection (`agentProtocolRouter().withV1().withV2()`)                 |
| `dist/examples/agent.js`              | Scripted v1 turn: message chunks, `tool_call`, `tool_call_update`, a real permission round trip |
| `dist/test-support/test-agent.js`     | Programmable test agent (chunk count, delay, optional permission)                               |

No model, no API key, no network, no added dependency — and version-locked to the
SDK we pin, so the target moves when the protocol we build against moves. Note
these are file paths, not package specifiers: the SDK's `exports` map does not
expose `./dist/*`.

The conformance test uses the dual-version one for two different jobs. The **v1**
arm is a regression guard on the path Copse ships — SDK client plus
`session-update-adapter.ts` — proving a v1 client still negotiates v1 against an
agent that also speaks v2. The **v2** arm asserts nothing about Copse; it pins the
wire shapes the migration must handle, read off a working agent instead of off the
RFDs: `initialize` requires the new `info` object (omit it and you get
`-32602 invalid initialize params`), the turn ends with a `state_update`
(`running` → `idle` + `stopReason`) rather than with the prompt response, and
whole messages keyed by `messageId` replace the chunk stream. When
`session-update-adapter.ts` learns v2, that arm is the checklist.

Gap: the v2 arm does not await `session.prompt()`, so it cannot see the
insertion receipt. On SDK 1.9.0 the prompt resolves with `{ messageId }` before
`idle`, and that id equals the `user_message` update's id; the arm should assert
both once the pin moves to 1.9.0.

When it fires, triage before bumping: confirm what the new surface actually
negotiates. If the migration will take longer than a night, add the new
`kind:name` to `ACKNOWLEDGED` in `scripts/acp-v2-watch.mts` with the reasoning —
the watch keeps reporting the surface and stops going red for a decision already
made.

## Prototype: what the seam actually costs

Two spike modules, **not wired into the product** — no import from `acp-client.ts`
or the session pool, so nothing in a shipping path changes:

- [`acp-protocol-negotiate.ts`](../src/main/services/acp/acp-protocol-negotiate.ts)
  — the version decision and its rules.
- [`acp-v2-session-adapter.ts`](../src/main/services/acp/acp-v2-session-adapter.ts)
  — v2 session updates to `StreamChunk`.

Both have unit tests, and the adapter is additionally driven end to end against
the SDK's dual-version example agent. Four findings, each of which changes the
plan below:

**1. The v2 client cannot fall back — and fails in a way you cannot read.** The
_protocol_ downgrades exactly as specified: ask a v1-only agent for
`protocolVersion: 2` and it answers `1`. The SDK's v2 _client_ does not. It
parses the initialize response against the v2 schema before checking the version,
so a v1 answer dies as a **ZodError on a missing `info`**, indistinguishable from
a genuinely broken agent. "Build the v2 client and catch the error" would
silently treat a sick agent as a v1 one. The seam therefore negotiates first with
a schema-free `initialize`, then builds the typed client for the answer. Cost:
one extra round trip, cacheable per agent exactly like `availableModels`.

**2. The v2 union does not narrow on its discriminant.** `switch
(update.sessionUpdate)` — precisely how `session-update-adapter.ts` reads v1 —
compiles, but every field of the narrowed member comes out `unknown`
(reproducible on a bare `tsc --strict`, so it is the published types, not our
config). The SDK ships generated guards for this: `SessionUpdate.isAgentMessageChunk(u)`
narrows properly. **v2 mapping is a guard chain, not a switch** — the v1 adapter's
shape does not survive the port. (Constructing typed literals works fine; it is
only reading that fails, so test fixtures need no casts.)

**3. ~~The whole-message upsert is free.~~ Retracted (2026-10-16).** Whole-message
updates do _not_ map onto `text_replace`. In the renderer `text_replace` replaces
the **current** assistant message (`src/renderer/controller/agent.ts`), not the
turn's text, so the prototype's "send the concatenation" collapses several
messages into one. Measured ([results](plans/acp-v2-execution-boundary.md#evidence-so-far)): revising the first of
two messages yields one message `"ONEtwo"`; a whole `agent_thought` is ignored; a
tool call whose first update is already `completed` stays `running`; tool output
(`rawOutput`/`content`, and Claude's `terminal_update`) never becomes a result;
and replay applied after live updates duplicates text. The missing piece is an
internal "replace message _X_" primitive for text and reasoning keyed by
`messageId` — the v1 path already carries ids through `acp_content`, but only for
appends.

**4. `StopReason` is not re-exported** from the v2 entry point — only reachable
as `schema.StopReason` inside the SDK's own declarations. Derive it from the
union rather than deep-importing.

What the prototype does **not** touch, and what therefore still carries the risk:
permissions, the `fs/*` write path, the session pool, and turn/usage plumbing.

**5. ACP v2 does not provide durability, dedupe or ownership.** Agents "are not
required to persist every inserted user message"; the returned id "is an
acknowledgment, not a client-supplied idempotency key"; clients "MUST NOT rely on"
agent or thought ids to deduplicate replay (only user message ids must stay
stable). Claude Code's ids did survive a process restart in the capture — because
it persists its own session file, not because the protocol requires it. The
thread store, the writer lease and submission dedupe stay Copse's.

## When v2 stabilizes — the plan

1. Negotiate the version per connection before building a client (finding 1
   above), sourcing the preferred version from per-agent configuration rather
   than a global switch — an install routinely has one v2-capable agent and
   several v1 ones. Keep the v1 surface either way: the migration guide is
   explicit that v1-only agents and clients stay common "for some time."
2. Add a v2 branch to `extractCapabilitySnapshot` reading the new `capabilities`
   / `info` shape, and probe with `--protocol 2` (sends `protocolVersion: 2`; a
   v1 agent still answers v1 and the matrix flags the downgrade).
3. Add a message-id-keyed replace for text and reasoning to the internal chunk
   vocabulary (finding 3), then teach `session-update-adapter.ts` the new update
   kinds (`state_update`, whole-message, tool-call upsert, `terminal_update`,
   `plan_update`) — as a guard chain, carrying the state the upsert model needs
   (finding 2). Conformance: fold every captured stream with a spec-literal
   reference fold and require equality with the Copse transcript (stage S1 of
   [`plans/acp-v2-execution-boundary.md`](plans/acp-v2-execution-boundary.md#staged-migration)).
4. Revisit permission handling to consume the structured `subject` — choosing
   options by `kind`, never by agent-defined id, and never treating `cancelled`
   or an unknown outcome as approval — and the write path now that `fs/*` is gone.
5. On the agent side (`copse --acp`), fix the v1 `text_replace`-as-append bug
   first ([#3829](https://github.com/copse-dev/agent-pane/pull/3829) removes the
   doubled text; the stripped markup needs v2), then add a v2 handler behind
   `agentProtocolRouter().withV1().withV2()` on the existing `AcpTurnContext`
   seam: respond to `session/prompt` on insertion with the spine user message id,
   and carry Copse-only data in `_meta["copse.dev"]`.

Until then this is a watch item, not a task — an automated one. The probe is
complete for the v1 surface Copse actually speaks.

## See also

- [`docs/acp-capability-probe.md`](acp-capability-probe.md) — the Tier-1 probe.
- [`docs/acp-agents.md`](acp-agents.md) — the v1 client integration.
- [`scripts/acp-v2-watch.mts`](../scripts/acp-v2-watch.mts) — the nightly registry watch.
- [ACP v2 RFDs](https://agentclientprotocol.com/rfds/v2/overview).
