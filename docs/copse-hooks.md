# Copse hooks (`.copse/hooks.json`)

Copse's **native** hook dialect (the [Copse-dialect phase](./plans/hooks-and-feature-packs.md#phase-f--copse-dialect-native-events-sandbox) of the hooks platform — see
[`docs/plans/hooks-and-feature-packs.md`](./plans/hooks-and-feature-packs.md)). It is the
counterpart to the imported [Cursor hooks](./cursor-hooks.md) and
[Claude hooks](./claude-hooks.md) dialects, but — because it is our own format — it speaks
the **canonical event names** and the **canonical decision vocabulary** directly, with no
vendor translation layer. It also exposes Copse-native knobs the imported dialects cannot:
`async`, `onFailure`, `sandbox`, and `loop_limit`.

Each hook is a process that receives a JSON payload on **stdin**, may print a JSON response
on **stdout**, and can observe, block, or annotate the action that triggered it. Dialect is
determined by source path (the [dialect-by-source-path decision](./plans/hooks-and-feature-packs.md#decisions-log)): `.copse/hooks.json` → the Copse adapter. For the
dialect-agnostic architecture (registry, canonical events, async/budget/epoch, spine,
sandbox, UI) see [`docs/hooks.md`](./hooks.md).

The official JSON schema is published at
[`schemas/copse-hooks.schema.json`](../schemas/copse-hooks.schema.json)
(`$id: https://copse.dev/schemas/copse-hooks.schema.json`); point your editor's
`json.schemas` mapping at it for completion + validation.

## On-disk layout

```
~/.copse/hooks.json             # user hooks — always honoured
<workspace>/.copse/hooks.json   # project hooks — only when the workspace is trusted
```

Example `.copse/hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "toolGate": [{ "command": "./hooks/guard.sh", "onFailure": "closed" }],
    "afterFileEdit": [{ "command": "./hooks/format.sh", "glob": "src/**/*.ts", "async": true }],
    "stop": [{ "command": "node hooks/notify.js", "loop_limit": 2 }],
    "subagentStart": [{ "command": "./hooks/allow-subagents.sh", "matcher": "^explore$" }]
  }
}
```

`command` is spawned with the directory of the declaring `hooks.json` as its working
directory, so relative paths resolve against the config.

## Canonical events

Copse hooks subscribe to canonical events directly (the same names the registry fires). The [Copse-dialect adapter phase](./plans/hooks-and-feature-packs.md#phase-f--copse-dialect-native-events-sandbox)
wires the events that already have a fire site; the not-yet-wired canonical events
(the [Copse-native event fire sites](./plans/hooks-and-feature-packs.md#phase-f--copse-dialect-native-events-sandbox) `beforeDiffApply` / `afterDiffApply` / `permissionDecision`, and the first-party
assembly events) are **accepted but reported as unsupported** in Sources — a declared hook
parses cleanly but does not fire until its phase lands.

| Event                | Dispatch                      | stdin (event fields)                              | stdout (canonical outcome)                                 |
| -------------------- | ----------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| `toolGate`           | blocking, decision            | `tool_name`, `input`, `file_content?`             | `decision`, `updatedInput`, `injectContext`, `haltRun`     |
| `beforeSubmitPrompt` | blocking, decision            | `prompt`                                          | `haltRun` / `continue:false`, `injectContext`, messages    |
| `afterFileEdit`      | blocking (async opt-in)       | `file_path`                                       | notification; async may return `queueMessage`              |
| `stop`               | async (detached)              | `status`                                          | notification; `queueMessage` follow-up (queue, [single-budget decision](./plans/hooks-and-feature-packs.md#decisions-log)) |
| `subagentStart`      | blocking, decision            | `subagent_type`, `subagent_model?`                | `decision` (`ask` → `deny`)                                |
| `subagentStop`       | async (detached)              | `subagent_type`, `status`                         | `queueMessage` follow-up (on `completed` only)             |
| `afterToolUse`       | async (detached, observation) | `tool_name`, `tool_call_id`, `is_error`, `output` | notification; `queueMessage` follow-up                     |
| `sessionStart`       | async (fire-and-forget)       | `first_turn`, `session_id`                        | `sessionEnv` (propagated to later hook spawns)             |

Every payload also carries the base envelope: `hook_event_name`, `conversation_id`,
`generation_id`, `workspace_roots`, and — when a run is active — `model`.

The stdout response is the canonical decision vocabulary spoken verbatim:

```json
{
  "decision": "allow" | "deny" | "ask",
  "haltRun": { "reason": "…" },
  "continue": false,
  "updatedInput": { "command": "…" },
  "injectContext": "…",
  "agentMessage": "…",
  "userMessage": "…",
  "queueMessage": { "text": "…", "sendNow": false },
  "sessionEnv": { "KEY": "value" }
}
```

Fields not applicable to an event are ignored (e.g. `updatedInput` outside `toolGate`, or a
`decision` from a notification-only `stop`). An empty stdout on a clean exit is an
intentional no-opinion.

## Copse-native fields

| Field        | Type                                                                                                                                                                                                                                                                                                                                                                          | Meaning                                                                                                                                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onFailure`  | `"open"` \| `"closed"`                                                                                                                                                                                                                                                                                                                                                        | How a failure (crash / timeout / invalid JSON) resolves (the [vendor failure semantics decision](./plans/hooks-and-feature-packs.md#decisions-log)). `open` (default) is no-opinion so a broken hook never wedges the agent; `closed` **blocks** the gated action. Same knob as Cursor `failClosed: true`.                         |
| `sandbox`    | boolean (default `true`)                                                                                                                                                                                                                                                                                                                                                      | Whether the hook runs inside the project sandbox (the [sandboxed-by-default decision](./plans/hooks-and-feature-packs.md#decisions-log)). `sandbox: false` is the escape — it runs **outside** the sandbox and Sources badges it "outside sandbox". **Enforced in F3** (macOS seatbelt); a default, not a guarantee elsewhere. |
| `async`      | boolean (default `false`)                                                                                                                                                                                                                                                                                                                                                     | Opt into **detached** dispatch (the [blocking-vs-async dispatch decision](./plans/hooks-and-feature-packs.md#decisions-log)). Honoured only on `afterFileEdit`; on a blocking decision event (`toolGate`, `beforeSubmitPrompt`, `subagentStart`) it is warned about and ignored.                                                     |
| `loop_limit` | integer \| **Reserved — parsed + validated, not yet enforced** (plan row C5). Per-script auto-continuation limit (the [unified auto-continuation budget decision](./plans/hooks-and-feature-packs.md#decisions-log)), **tighten-only**: will bound this hook's machine-turn contributions to `min(loop_limit, global remaining)`. Today only the global auto-continuation budget (cap 5) applies; `null` (unlimited) already warns — human-in-the-loop is the floor. | Per-script auto-continuation limit (the [unified auto-continuation budget decision](./plans/hooks-and-feature-packs.md#decisions-log)), **tighten-only**. Bounds this hook's machine-turn contributions to `min(loop_limit, global remaining)`. `null` (unlimited) is clamped to the global budget with a warning.                         |
| `timeout`    | number (seconds)                                                                                                                                                                                                                                                                                                                                                              | Per-hook timeout override. Default 30s.                                                                                                                                                                                                             |
| `matcher`    | regex string                                                                                                                                                                                                                                                                                                                                                                  | Filters which actions the hook fires for: the canonical tool name for `toolGate` / `afterToolUse`, the subagent type for `subagentStart` / `subagentStop`. A malformed regex skips the hook (skip-and-warn).                                        |
| `glob`       | string \| string[]                                                                                                                                                                                                                                                                                                                                                            | For `afterFileEdit` only — the hook fires only for edited paths matching a glob (absolute, workspace-relative, and basename are all tried).                                                                                                         |

## Reliability and trust

- **Fail-open by default.** A crash / timeout / invalid JSON is treated as no-opinion so a
  broken hook never wedges the agent. Set `onFailure: "closed"` to block the action on
  failure instead.
- **Trust gate.** User hooks (`~/.copse/hooks.json`) are always honoured (you installed
  them). Project hooks (`<workspace>/.copse/hooks.json`) run only when the workspace is
  trusted, because honouring them spawns scripts from a possibly-cloned repo.
- <a id="security"></a>**Sandbox by default.** Hook processes run **inside the
  project sandbox by default** (the [sandbox phase](./plans/hooks-and-feature-packs.md#phase-f--copse-dialect-native-events-sandbox) reversed the earlier outside-sandbox spawn — the [sandboxed-by-default decision](./plans/hooks-and-feature-packs.md#decisions-log)).
  This applies to every dialect: Cursor and Claude hooks cannot express the escape, so they
  are always sandboxed-by-default; only the Copse `sandbox: false` field opts a hook **out**,
  running it outside the sandbox with full authority (Sources badges it "outside sandbox").
  Enforcement is **macOS-only** (seatbelt via ASRT); on Linux / Windows
  `isProjectSandboxEnabled()` is hard-false, so "sandboxed" is a _default, not a guarantee_.
  A **sandbox-blocked** hook is never a silent fail-open: the block is recorded on the spine
  (`sandboxBlocked: true`, keyed off runner-side violation signals — never the hook's own
  stdout, issue #104), surfaced in Sources as a per-hook error, and resolved through the
  hook's `onFailure` (`closed` → deny; `open` → no-opinion but still recorded).
- **Always-on spine recording.** Every hook execution writes a `hook_run` line to the
  thread spine with stdout **and** stderr captured, next to the normalized decision and a
  `parse_ok` flag (the [always-on spine recording decision](./plans/hooks-and-feature-packs.md#decisions-log)), so a debug print that corrupts a response is visible.

## Scope: what F1 does and does not do

The [Copse-dialect adapter phase](./plans/hooks-and-feature-packs.md#phase-f--copse-dialect-native-events-sandbox) added the dialect adapter, discovery, parsing, matchers, wire marshalling, the per-event
`onFailure` table, unsupported-capability reporting, the published JSON schema, and Sources
listing. The [Copse-native event fire sites phase](./plans/hooks-and-feature-packs.md#phase-f--copse-dialect-native-events-sandbox) wired the Copse-native event fire sites (`beforeDiffApply` / `afterDiffApply` /
`permissionDecision` / `postTurnReview`). [**The sandbox phase**](./plans/hooks-and-feature-packs.md#phase-f--copse-dialect-native-events-sandbox) consumes the `sandbox` field: the
sandbox-by-default spawn reversal (macOS enforcement), the `sandbox: false` escape surfaced
in Sources, and blocked-by-sandbox recording. The `loop_limit` field is still parsed /
carried for the [auto-continuation budget phase](./plans/hooks-and-feature-packs.md#phase-c--async-executor-output-channel-budget)'s drain-time budget enforcement.
