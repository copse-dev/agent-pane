# Cursor hooks support in Copse

[Cursor hooks](https://cursor.com/docs/hooks) are user-provided scripts registered in a
`hooks.json` file that the agent spawns at points in its loop. Each hook is a process
that receives a JSON payload on **stdin**, may print a JSON response on **stdout**, and
can observe, block, or annotate the action that triggered it.

This document records the Cursor hooks contract, what Copse honours today, and what
remains for fuller parity. It is the hooks counterpart to
[`docs/cursor-plugins.md`](./cursor-plugins.md). For the cross-cutting architecture — the
unified registry, canonical events, executors, async/budget/epoch, spine, sandbox, and UI
that are dialect-agnostic — see [`docs/hooks.md`](./hooks.md).

## On-disk layout

```
~/.cursor/hooks.json        # user hooks — always honoured
<workspace>/.cursor/hooks.json  # project hooks — only when the workspace is trusted
```

Example `hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "beforeShellExecution": [{ "command": "./hooks/audit.sh", "failClosed": true }],
    "beforeMCPExecution": [{ "command": "node hooks/mcp-guard.js" }],
    "beforeReadFile": [{ "command": "./hooks/redact.sh" }]
  }
}
```

`command` is a shell command spawned with the directory of the `hooks.json` as its
working directory, so relative paths resolve against the config. A hook may set
`"failClosed": true` to make a crash / timeout / invalid JSON **block** the action
instead of failing open (see Reliability and trust below).

## Hook events and I/O

Each hook receives a base payload — `conversation_id`, `generation_id`,
`hook_event_name`, `workspace_roots` — plus event-specific fields. Every
agent-session event also carries the **model identity** of the model actually
running the turn: `model` (slug), `model_id`, and `model_params` (Cursor's
`{ id, value }[]` array — e.g. `context_window` / `max_output_tokens`), matching
the vendor contract (the [permission-hook I/O phase](plans/hooks-and-feature-packs.md#phase-b--complete-the-cursor-declared-surface)).

| Event                  | stdin (event fields)                                                                                         | stdout                                   | Copse                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `beforeShellExecution` | `command`, `cwd`                                                                                             | `{ permission: "allow"\|"deny"\|"ask" }` | ✅ honoured                                                                                                          |
| `beforeMCPExecution`   | `tool_name`, `tool_input`                                                                                    | `{ permission: "allow"\|"deny"\|"ask" }` | ✅ honoured                                                                                                          |
| `beforeReadFile`       | `file_path`, `content`                                                                                       | `{ permission: "allow"\|"deny" }`        | ✅ honoured                                                                                                          |
| `preToolUse`           | `tool_name` (tool type), `tool_input`, `cwd`                                                                 | `{ permission, updated_input }`          | ✅ wired                                                                                                             |
| `beforeSubmitPrompt`   | `prompt`, `attachments`                                                                                      | `{ continue: boolean }`                  | ✅ wired ([beforeSubmitPrompt](plans/hooks-and-feature-packs.md#phase-b--complete-the-cursor-declared-surface))      |
| `afterFileEdit`        | `file_path`, `edits`                                                                                         | none (notification)                      | ✅ wired ([afterFileEdit](plans/hooks-and-feature-packs.md#phase-b--complete-the-cursor-declared-surface))           |
| `stop`                 | `status`, `loop_count`                                                                                       | `followup_message` (queued)              | ✅ wired ([stop](plans/hooks-and-feature-packs.md#phase-b--complete-the-cursor-declared-surface))                    |
| `afterShellExecution`  | `command`, `output`, `duration`                                                                              | none (notification)                      | ✅ wired ([afterShellExecution / afterMCPExecution](plans/hooks-and-feature-packs.md#phase-d--parity-tier-2-events)) |
| `afterMCPExecution`    | `tool_name`, `tool_input`, `result_json`, `duration`                                                         | none (notification)                      | ✅ wired ([afterShellExecution / afterMCPExecution](plans/hooks-and-feature-packs.md#phase-d--parity-tier-2-events)) |
| `postToolUse`          | `tool_name`, `tool_input`, `tool_output`, `tool_use_id`, `cwd`, `duration`                                   | `additional_context` (queued)            | ✅ wired                                                                                                             |
| `postToolUseFailure`   | `tool_name`, `tool_input`, `tool_use_id`, `cwd`, `error_message`, `failure_type`, `duration`, `is_interrupt` | none                                     | ✅ wired                                                                                                             |

The real `conversation_id` (thread id) and `generation_id` (turn id) come from
the active run (the [permission-hook I/O phase](plans/hooks-and-feature-packs.md#phase-b--complete-the-cursor-declared-surface)); they are empty strings only when a hook fires outside any
agent turn.

### Matchers (per-event, [matcher support](plans/hooks-and-feature-packs.md#phase-d--parity-tier-2-events))

A hook entry may carry an optional `matcher` — a **regex string** that filters
when the hook runs. Which field the regex is tested against depends on the event
(matching Cursor's "which field the matcher applies to depends on the hook"):

| Event(s)                                            | matcher matched against       |
| --------------------------------------------------- | ----------------------------- |
| `beforeShellExecution` / `afterShellExecution`      | the full shell command string |
| `beforeMCPExecution` / `afterMCPExecution`          | the (MCP) tool name           |
| `beforeReadFile`                                    | the tool type (`Read`)        |
| `afterFileEdit`                                     | the tool type (`Write`)       |
| `beforeSubmitPrompt`                                | the value `UserPromptSubmit`  |
| `stop`                                              | the value `Stop`              |
| `subagentStart` / `subagentStop`                    | the subagent type             |
| `preToolUse` / `postToolUse` / `postToolUseFailure` | the Cursor tool type          |

```json
{
  "hooks": {
    "beforeShellExecution": [{ "command": "./approve-network.sh", "matcher": "curl|wget|nc " }],
    "beforeMCPExecution": [{ "command": "./mcp-guard.sh", "matcher": "db__query" }],
    "subagentStart": [{ "command": "./validate-explore.sh", "matcher": "explore|shell" }]
  }
}
```

Semantics:

- **No matcher fires for every action** — Cursor's default. (For `afterFileEdit`,
  Copse _additionally_ supports a `glob` convenience field, matched against the
  edited **path**; see below.)
- **An invalid regex skips the hook** (skip-and-warn). Cursor's docs do not
  specify invalid-matcher behavior; Copse chooses to skip rather than fail-open
  so a broken matcher can never accidentally deny (or observe) every action. The
  skip is logged once with the offending pattern.
- **MCP tool names** are Copse's canonical form (`mcp__<server>__<tool>`), so an
  MCP matcher is written against that — e.g. `db__query` matches
  `mcp__db__query`. (Cursor's dedicated `beforeMCPExecution` / `afterMCPExecution`
  events are not in its published "available matchers" list; Copse matches them
  by tool name, the natural analogue of Cursor's `MCP:<tool_name>` tool-type
  token used by the generic `preToolUse` hook.)
- **Generic post-tool names** use Cursor's tool-type tokens: `Shell`, `Read`,
  `Write`, `Grep`, `Delete`, `Task`, and `MCP:<canonical-tool-name>`. Copse-native
  tools with no direct Cursor analogue keep their canonical id.
- **`afterFileEdit` has two independent filters** that must _both_ pass: the
  Copse-convenience `glob` (**path**, `string | string[]`, B2) and the Cursor
  native `matcher` (**tool type** `Write`, D3). They are distinct fields with
  distinct meanings — `glob` narrows by which file changed, `matcher` narrows by
  the edit tool type. Since every Copse edit funnels through the diff-queue write
  path, a `Write` matcher matches and a `TabWrite` matcher never does (Copse has
  no inline-tab edits).

Matcher evaluation is centralized in the Cursor adapter
(`cursorMatcherMatches` / `cursorMatcherSubject`) and applied at discovery — the
adapter's dispatch-side filter — so every event runs the same matcher code with
only its subject field differing (the [dialect-by-source-path decision](plans/hooks-and-feature-packs.md#decisions-log): adapters own matchers).

### Two deliberate divergences

**`preToolUse` `ask`.** Cursor's docs say `ask` "is accepted by the schema but
not enforced for `preToolUse` today" — upstream it behaves as allow. Copse
_does_ enforce it, escalating to its own approval prompt. That is a divergence in
the tightening direction, consistent with the dedicated flavors (where Cursor
does enforce `ask`) and with the rule that a hook can only ever tighten the gate.

**`stop` / `subagentStop` follow-ups are queued _held_, not auto-submitted.**
Upstream, a `followup_message` is submitted automatically as the next user
message — that is what makes loop-style flows work, and what `loop_limit` exists
to bound. Copse fires both events **detached** (decision 3), so by the time a
hook responds there is no turn to submit into, and silently auto-starting one is
exactly the bespoke protocol decision 4 rules out. The follow-up therefore lands
in the pending-message queue with `sendNow: false` — **held**, waiting for the
user to drain it.

Note this is a property of _these two events_, not of Copse: Copse does auto-continue
(the [unified auto-continuation budget](./hooks.md#loop_limit-clamp-divergence-cursor-unlimited-vs-copse-clamped),
capped per turn tree, covers hook send-now, remediation, and closeout turns). A
held follow-up simply never spends that budget until a human sends it.

Two consequences worth knowing:

- **`loop_limit` is ignored in a `.cursor/hooks.json`.** The field is parsed and
  validated only by the [Copse dialect](./copse-hooks.md#copse-native-fields),
  where it is reserved pending
  [plan row C5](./plans/hooks-and-feature-packs.md#phase-c--async-executor-output-channel-budget).
  The Cursor adapter does not read it at all, so it is dropped silently — not
  even the reserved-field warning the Copse adapter emits. Since a Cursor
  follow-up is held rather than auto-submitted, nothing is currently unbounded by
  that; when C5 wires per-script enforcement, the Cursor adapter needs to start
  parsing it too.
- **`loop_count` on `stop` stdin is always `0`**, honestly so: a held follow-up
  has by definition never re-triggered a run. It is sent rather than omitted
  because vendor hook scripts read it unconditionally — Cursor's own documented
  example gates on `loop_count < 4`, which an absent field makes silently false.

Permission responses may also carry `agentMessage` / `userMessage`. A denying
hook's `agentMessage` is now **surfaced to the agent** as the tool-result reason
(the [permission-hook I/O phase](plans/hooks-and-feature-packs.md#phase-b--complete-the-cursor-declared-surface)) — a message-bearing `deny` fails the call with that reason so the model sees
why. A hook `ask` **escalates to Copse's approval prompt** (the same prompt a
policy `ask` uses): approving lets the call proceed, declining blocks it. A hook
still can only _tighten_ the gate — an `allow` never auto-approves something
Copse would otherwise prompt about.

`beforeReadFile` receives the file **content** on stdin (the [permission-hook I/O phase](plans/hooks-and-feature-packs.md#phase-b--complete-the-cursor-declared-surface)), so a redaction /
secret-detection hook can inspect the bytes and `deny`. Cursor's `beforeReadFile`
response is `allow` / `deny` only — there is no content-rewrite field in the
vendor contract — so "redaction" is expressed as _deny on inspection_, not by
returning modified content.

## What Copse supports

| Capability                    | Status        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Permission hooks**          | Supported     | `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile` run in the permission gate                                                                                                                                                                                                                                                                                                                                                                    |
| **User hooks**                | Supported     | `~/.cursor/hooks.json`, always honoured                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Project hooks**             | Supported     | `<root>/.cursor/hooks.json`, only when the workspace is trusted (#100)                                                                                                                                                                                                                                                                                                                                                                                       |
| **Hook discovery / list**     | Supported     | `hooks:list` IPC returns hooks + validation warnings for the Sources panel                                                                                                                                                                                                                                                                                                                                                                                   |
| **Lifecycle hooks**           | Supported     | `beforeSubmitPrompt`, `afterFileEdit`, `stop`, `afterShellExecution` / `afterMCPExecution` are wired ([phase B](plans/hooks-and-feature-packs.md#phase-b--complete-the-cursor-declared-surface), [phase D](plans/hooks-and-feature-packs.md#phase-d--parity-tier-2-events))                                                                                                                                                                                  |
| **Generic `preToolUse`**      | Supported     | The pre-side twin of `postToolUse`: gates **every** tool, not just the shell / MCP / read calls the dedicated flavors cover, so a hook can deny a write, a search, or a subagent spawn. Matcher is the Cursor tool-type token (`Shell`, `Read`, `Write`, `Grep`, `Delete`, `Task`, `MCP:<tool_name>`). Fires alongside a dedicated flavor when both are declared                                                                                             |
| **Unwired Cursor events**     | Not supported | `sessionEnd`, `preCompact`, `afterAgentResponse`, `afterAgentThought`, the Tab events `beforeTabFileRead` / `afterTabFileEdit`, and the app-lifecycle `workspaceOpen` are recognised and **reported as unsupported** in Sources rather than dismissed as typos. Copse has no inline-tab surface at all, no canonical session-end / compaction fire site yet, and nowhere to hang an event that fires outside any agent session                               |
| **Post-tool observation**     | Supported     | `afterShellExecution` / `afterMCPExecution` plus generic `postToolUse` / `postToolUseFailure` fire **detached** from the one canonical `afterToolUse` event. Generic events cover every tool and split on success/failure; the output snapshot is capped before it reaches hook stdin. Because detached hooks cannot mutate an already-consumed result, `additional_context` becomes a budgeted queued message and `updated_mcp_tool_output` is not applied. |
| **`beforeReadFile` content**  | Supported     | The hook receives the file contents on stdin ([permission-hook I/O](plans/hooks-and-feature-packs.md#phase-b--complete-the-cursor-declared-surface)) so it can inspect and `deny` (redaction = deny-on-inspection; Cursor has no content-rewrite response)                                                                                                                                                                                                   |
| **Model identity in payload** | Supported     | `model` / `model_id` / `model_params` on every agent-session event ([permission-hook I/O](plans/hooks-and-feature-packs.md#phase-b--complete-the-cursor-declared-surface)), sourced from the model actually running                                                                                                                                                                                                                                          |
| **`agentMessage` / `ask`**    | Supported     | A denying hook's `agentMessage` reaches the agent as the tool-result reason; a hook `ask` escalates to Copse's approval prompt ([permission-hook I/O](plans/hooks-and-feature-packs.md#phase-b--complete-the-cursor-declared-surface))                                                                                                                                                                                                                       |
| **Content rewriting**         | Not supported | Hooks can block but not yet mutate prompts, read output, or edits (`updated_input` is the [tool-gate input rewriting phase](plans/hooks-and-feature-packs.md#phase-h--vendor-response-semantics))                                                                                                                                                                                                                                                            |
| **Plugin-contributed hooks**  | Not supported | Marketplace plugins do not declare hooks in current `plugin.json` examples                                                                                                                                                                                                                                                                                                                                                                                   |
| **Settings UI**               | Supported     | Developer mode → Settings → Sources → Hooks: `cursorHooksEnabled` toggle, discovered hooks, per-entry validation warnings, per-hook runtime error state (first failure per session)                                                                                                                                                                                                                                                                          |

### Enablement

Hooks are **off by default**. Honouring a hook spawns a user/project script on the
agent's hot path, so it is gated behind the `cursorHooksEnabled` security setting
(Developer mode → Settings → Sources → Hooks). When disabled the gate skips discovery entirely (no
overhead); the Sources panel still lists discovered hooks so authoring problems are
visible before enabling.

### Implementation

Cursor is a **dialect adapter** (the [dialect-adapter phase](plans/hooks-and-feature-packs.md#phase-a--foundations) of the hooks platform,
[`docs/plans/hooks-and-feature-packs.md`](plans/hooks-and-feature-packs.md), the [dialect-by-source-path decision](plans/hooks-and-feature-packs.md#decisions-log):
"dialect by source path"). Discovery, parsing, matchers, wire marshalling in both
directions, and the per-event exit-code table all live in
[`src/main/services/hooks/cursor-adapter.ts`](../src/main/services/hooks/cursor-adapter.ts):

- `listCursorHooks()` — discovered hooks for the current context (diagnostics / `hooks:list`)
- `cursorToolGateHooks(payload, opts)` — the Cursor command hooks matching a tool gate,
  as canonical `CommandHook`s (their `onFailure` set from `failClosed`)
- `cursorAdapter` — the `DialectAdapter` the shared runner delegates to (marshalling +
  the exit-code table)

The shared process spawn (stdin marshalling, stdout/stderr capture, timeout, output cap)
lives in [`hook-spawn.ts`](../src/main/services/hooks/hook-spawn.ts); the host runner in
[`command-hook-runner.ts`](../src/main/services/hooks/command-hook-runner.ts) spawns each
hook and applies its dialect's failure semantics.

The permission gate ([`permission-gate.ts`](../src/main/services/security/permission-gate.ts))
maps a tool call onto the canonical `toolGate` event and calls
`runToolGateHooks` ([`tool-gate.ts`](../src/main/services/hooks/tool-gate.ts)), which fires
the hooks through the registry → runner → adapter seam. Hooks can only **tighten** the gate:
a `deny` blocks the call, but an `allow` still flows through Copse's normal prompting — a
hook can never auto-approve something Copse would otherwise ask about.

### Reliability and trust

- **Fail open by default, `failClosed` honoured.** A missing config, crash, timeout (5s),
  or unparseable response is treated as `allow`, so a broken hook never silently wedges
  the agent. But Cursor's per-hook `failClosed: true` (`{ "command": …, "failClosed": true }`)
  reverses that for **that** hook: a crash / timeout / invalid JSON **blocks** the action
  instead — the vendor contract for imported security hooks (the [vendor failure semantics decision](plans/hooks-and-feature-packs.md#decisions-log)). The Cursor
  adapter reports the failure + the hook's resolved `onFailure`; the runner turns it into
  a deny (`failClosed`) or a no-op (the default).
- **No LLM secrets.** Hook processes inherit `envForRendererChildProcess()` — the same
  scrubbed environment as `run_shell`, so provider _LLM_ API keys never reach hook
  scripts. Note this is **not** an empty environment: non-LLM tool tokens that the agent
  uses (for example `GITHUB_TOKEN`) are still present — see the Security section below.
- **Output is capped** at 1 MB to bound a runaway hook.

| Source                        | Trust                                                         |
| ----------------------------- | ------------------------------------------------------------- |
| `~/.cursor/hooks.json` (user) | Trusted — the user authored it                                |
| `<root>/.cursor/hooks.json`   | Requires workspace trust (#100); skipped for untrusted clones |

## Security

Enabling Cursor hooks hands real, local execution authority to whoever authored the
`hooks.json`. Read this before turning the feature on.

**Enabling `cursorHooksEnabled` and trusting a workspace grants that repo's
`.cursor/hooks.json` arbitrary local code execution on every gated tool call.** Each
matching hook `command` is spawned through a shell on the agent's hot path, with the
directory of the `hooks.json` as its working directory. A trusted repo's hooks run with
whatever authority the sandbox leaves them (see below).

Concretely, "trusting a workspace" with hooks enabled also means:

- **Arbitrary code on every tool call.** Any tool call that maps to a hook event
  (`beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`) spawns the repo's
  hook command first. A cloned or third-party repo can ship a `hooks.json` that runs
  whatever it likes, repeatedly, for the lifetime of the session.
- **Sandboxed by default (the [sandbox phase](plans/hooks-and-feature-packs.md#phase-f--copse-dialect-native-events-sandbox), macOS-only).** Hook processes run inside the project sandbox by default (the [sandboxed-by-default decision](plans/hooks-and-feature-packs.md#decisions-log) of the
  [hooks platform plan](./plans/hooks-and-feature-packs.md)), hook processes run **inside
  the project sandbox by default** — the same workspace-scoped seatbelt that constrains the
  agent's shell/file tools. Cursor / Claude hooks cannot opt out (only the Copse dialect's
  `sandbox: false` can). **Enforcement is macOS-only**: on Linux / Windows there is no OS
  sandbox, so a hook still runs with full user authority — treat "sandboxed" as a _default,
  not a guarantee_. A hook the sandbox blocks is recorded on the spine and surfaced in
  Sources; it is never a silent fail-open.
- **Tool tokens are in the environment.** Hook processes inherit the scrubbed
  `envForRendererChildProcess()` environment. That strips _LLM provider_ keys, but
  **non-LLM tool tokens used by the agent (e.g. `GITHUB_TOKEN`) remain in `env`** and are
  therefore readable by a hook script.
- **Fail open — can tighten, never relied on to block.** Hooks fail open by design
  (timeout, crash, non-JSON, or oversized output → treated as `allow`). A hook can
  _tighten_ Copse's permission gate (a `deny` blocks a call), but it can never be relied
  upon to block: do not treat a `deny`-returning hook as a security control, because any
  failure path silently degrades to `allow`.

**Mitigations and guidance:**

- The feature is **off by default**. Leave it off unless you specifically need it.
- Only enable it for workspaces you would already trust to run arbitrary code on your
  machine — the same bar as running the repo's build scripts or `npm install`.
- Project hooks are only honoured when the workspace is trusted (#100); untrusted clones
  are skipped entirely. Trust is the gate — granting it is the consent.
- When a **project-supplied** hook command runs for the first time in a session, Copse
  logs a one-time warning naming the command, so it is auditable in the logs.

This is the same trust boundary described in
[`docs/supply-chain-security.md`](./supply-chain-security.md): trusting a workspace means
trusting the code it can cause to run.

## Vendored upstream schemas & drift detection

Copse pins committed copies of the upstream hook-config JSON schemas for both
foreign dialects under [`schemas/vendor/`](../schemas/vendor/) —
`claude-code-settings.schema.json` (Claude Code, from SchemaStore) and
`cursor-hooks.schema.json` (the community `cursor-hooks` npm schema). See
[`schemas/vendor/README.md`](../schemas/vendor/README.md) for provenance, pins,
and the re-vendoring steps.

These exist for exactly two purposes, and are subject to two hard rules — they
are **never fetched over the network** at runtime or in CI, and they are **never
a load gate** (a config that violates an upstream schema still loads):

1. **Warn-level authoring lint.** Parsing a foreign config uses the schema's
   published event list to warn when a hooks group targets an event the vendor
   recognises but Copse does not act on yet (vs an outright typo). The valid
   hooks still load; the warning surfaces in Settings → Sources.
2. **CI drift detector** (`src/main/services/hooks/vendor-schema-drift.test.ts`)
   diffs each vendored schema's published events against the events our adapters
   wire. Every published event must be either wired or listed in an explicit
   intentionally-unsupported set (`src/shared/hooks/vendored-hook-schemas.ts`); an
   upstream release adding an unaccounted event fails CI until it is wired or
   documented. Copse currently wires Claude `PreToolUse` + `SessionStart` and the
   Cursor events above; the long tail of Claude events (`Notification`,
   `TeammateIdle`, …) is intentionally-unsupported v1.

## Wire payload snapshots

Every dialect wire **request** payload — the stdin JSON a Cursor / Claude / Copse
hook actually receives — is snapshot-tested against a committed golden fixture
[`src/main/services/hooks/__snapshots__/wire-payloads.json`](../src/main/services/hooks/__snapshots__/wire-payloads.json)
by [`src/main/services/hooks/payload-snapshots.test.ts`](../src/main/services/hooks/payload-snapshots.test.ts).
The test marshals a fixed synthetic payload (with a fixed agent-session identity,
so the B4 `model` fields are captured) for every canonical event each dialect
declares a marshaller for — including the tool-flavor splits (shell / MCP / read
for `toolGate`, shell / MCP for `afterToolUse`) — and asserts the result is
byte-identical to the fixture.

This implements the [**payload stability at publish** decision](plans/hooks-and-feature-packs.md#decisions-log) of
[`docs/plans/hooks-and-feature-packs.md`](plans/hooks-and-feature-packs.md):
pre-v1 with zero consumers we do not version payloads, but the request direction
is the stability contract, so **changing a snapshot is a publish-time stability
audit** — the reviewed JSON diff of the golden fixture _is_ the stability
declaration. Regenerate the fixture (and review the diff) with:

```bash
UPDATE_HOOK_PAYLOAD_SNAPSHOTS=1 npm test
```

## Gaps and future work

1. **Content rewriting** — `updated_input` on tool gates (rewrite the proposed tool
   input, re-running policy analysis) is the [tool-gate input rewriting phase](plans/hooks-and-feature-packs.md#phase-h--vendor-response-semantics), not yet wired.
2. **Hook cards** — deny/ask decisions and hook executions surface today through the
   existing text / approval-prompt channels; the dedicated right-aligned hook-card
   UI family is the [hook cards UI phase](plans/hooks-and-feature-packs.md#phase-g--validation--tooling). `userMessage` on a plain deny (no approval prompt) waits
   for that card surface.
3. **Claude `SessionStart` model** — the wire payload type carries the running model
   (`AgentSessionInfo`), but Claude's optional `model` on `sessionStart` needs the
   `sessionStart` fire site, which is the [per-hook timeout + sessionStart phase](plans/hooks-and-feature-packs.md#phase-h--vendor-response-semantics); Cursor agent-session events carry
   model identity now (the [permission-hook I/O phase](plans/hooks-and-feature-packs.md#phase-b--complete-the-cursor-declared-surface)).
4. **Plugin-contributed hooks** — if Cursor adds a `hooks` slot to `plugin.json`, load
   them via the shared `cursor-plugins` discovery module.

## Related files

- `src/main/services/hooks/cursor-adapter.ts` — Cursor dialect adapter: discovery, parsing
  (incl. `failClosed`), matchers, wire marshalling, exit-code table
- `src/main/services/hooks/claude-adapter.ts` — Claude Code PreToolUse dialect adapter (#639)
- `src/main/services/hooks/hook-spawn.ts` — shared process spawn + stdout/stderr capture
- `src/main/services/hooks/command-hook-runner.ts` — host runner; applies dialect failure semantics
- `src/main/services/hooks/tool-gate.ts` — maps tool calls onto the canonical `toolGate` event
- `src/main/services/security/permission-gate.ts` — calls the tool-gate hooks
- `src/shared/types/cursor-hooks.ts` — `CursorHookEvent` / `CursorHookSummary`
- `src/shared/types/hooks.ts` — shared `HookSummary` for Sources / `hooks:list`
- `src/shared/hooks/vendored-hook-schemas.ts` — published-event mirrors + intentionally-unsupported sets ([vendored schemas](plans/hooks-and-feature-packs.md#phase-g--validation--tooling))
- `schemas/vendor/` — pinned upstream Cursor + Claude hook schemas ([vendored schemas](plans/hooks-and-feature-packs.md#phase-g--validation--tooling)); see its `README.md`
- `src/main/services/hooks/vendor-schema-drift.test.ts` — CI drift detector ([vendored schemas](plans/hooks-and-feature-packs.md#phase-g--validation--tooling))
- `src/main/services/hooks/payload-snapshots.test.ts` — dialect wire payload snapshot tests ([wire payload snapshots](plans/hooks-and-feature-packs.md#phase-g--validation--tooling))
- `src/main/services/hooks/__snapshots__/wire-payloads.json` — committed golden wire-payload fixture ([wire payload snapshots](plans/hooks-and-feature-packs.md#phase-g--validation--tooling))
- `src/main/services/exec/child-process-env.ts` — secret-scrubbed env for hook processes
- `docs/hooks.md` — dialect-agnostic hooks architecture umbrella
- `docs/claude-hooks.md` — Claude Code hooks contract
- `docs/cursor-plugins.md` — sibling exploration of Cursor plugin support
- `docs/supply-chain-security.md` — trust boundaries for executed code
