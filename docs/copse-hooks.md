# Copse hooks (`.copse/hooks.json`)

Copse's **native** hook dialect (F1 of the hooks platform — see
[`docs/plans/hooks-and-feature-packs.md`](./plans/hooks-and-feature-packs.md)). It is the
counterpart to the imported [Cursor hooks](./cursor-hooks.md) and
[Claude hooks](./claude-hooks.md) dialects, but — because it is our own format — it speaks
the **canonical event names** and the **canonical decision vocabulary** directly, with no
vendor translation layer. It also exposes Copse-native knobs the imported dialects cannot:
`async`, `onFailure`, `sandbox`, and `loop_limit`.

Each hook is a process that receives a JSON payload on **stdin**, may print a JSON response
on **stdout**, and can observe, block, or annotate the action that triggered it. Dialect is
determined by source path (decision 8): `.copse/hooks.json` → the Copse adapter.

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

Copse hooks subscribe to canonical events directly (the same names the registry fires). F1
wires the events that already have a fire site; the not-yet-wired canonical events
(F2-native `beforeDiffApply` / `afterDiffApply` / `permissionDecision`, and the first-party
assembly events) are **accepted but reported as unsupported** in Sources — a declared hook
parses cleanly but does not fire until its phase lands.

| Event                | Dispatch                      | stdin (event fields)                              | stdout (canonical outcome)                                 |
| -------------------- | ----------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| `toolGate`           | blocking, decision            | `tool_name`, `input`, `file_content?`             | `decision`, `updatedInput`, `injectContext`, `haltRun`     |
| `beforeSubmitPrompt` | blocking, decision            | `prompt`                                          | `haltRun` / `continue:false`, `injectContext`, messages    |
| `afterFileEdit`      | blocking (async opt-in)       | `file_path`                                       | notification; async may return `queueMessage`              |
| `stop`               | async (detached)              | `status`                                          | notification; `queueMessage` follow-up (queue, decision 4) |
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

| Field        | Type                      | Meaning                                                                                                                                                                                                                     |
| ------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onFailure`  | `"open"` \| `"closed"`    | How a failure (crash / timeout / invalid JSON) resolves (decision 9). `open` (default) is no-opinion so a broken hook never wedges the agent; `closed` **blocks** the gated action. Same knob as Cursor `failClosed: true`. |
| `sandbox`    | boolean (default `true`)  | Whether the hook runs inside the project sandbox (decision 7). `sandbox: false` is the escape, surfaced in the trust prompt. **Parsed in F1; enforcement is F3** and macOS-only — a default, not a guarantee.               |
| `async`      | boolean (default `false`) | Opt into **detached** dispatch (decision 2). Honoured only on `afterFileEdit`; on a blocking decision event (`toolGate`, `beforeSubmitPrompt`, `subagentStart`) it is warned about and ignored.                             |
| `loop_limit` | integer \| `null`         | Per-script auto-continuation limit (decision 5), **tighten-only**. Bounds this hook's machine-turn contributions to `min(loop_limit, global remaining)`. `null` (unlimited) is clamped to the global budget with a warning. |
| `timeout`    | number (seconds)          | Per-hook timeout override. Default 30s.                                                                                                                                                                                     |
| `matcher`    | regex string              | Filters which actions the hook fires for: the canonical tool name for `toolGate` / `afterToolUse`, the subagent type for `subagentStart` / `subagentStop`. A malformed regex skips the hook (skip-and-warn).                |
| `glob`       | string \| string[]        | For `afterFileEdit` only — the hook fires only for edited paths matching a glob (absolute, workspace-relative, and basename are all tried).                                                                                 |

## Reliability and trust

- **Fail-open by default.** A crash / timeout / invalid JSON is treated as no-opinion so a
  broken hook never wedges the agent. Set `onFailure: "closed"` to block the action on
  failure instead.
- **Trust gate.** User hooks (`~/.copse/hooks.json`) are always honoured (you installed
  them). Project hooks (`<workspace>/.copse/hooks.json`) run only when the workspace is
  trusted, because honouring them spawns scripts from a possibly-cloned repo.
- <a id="security"></a>**Sandbox by default (F3).** Hooks are intended to run inside the
  project sandbox; `sandbox: false` requests running **outside** it. F1 parses and surfaces
  this field, and the trust prompt calls out any `sandbox: false` escape. The
  sandbox-by-default spawn reversal + enforcement lands in F3 and is macOS-only — treat
  "sandboxed" as a default, not a guarantee, until then.
- **Always-on spine recording.** Every hook execution writes a `hook_run` line to the
  thread spine with stdout **and** stderr captured, next to the normalized decision and a
  `parse_ok` flag (decision 6), so a debug print that corrupts a response is visible.

## Scope: what F1 does and does not do

F1 adds the dialect adapter, discovery, parsing, matchers, wire marshalling, the per-event
`onFailure` table, unsupported-capability reporting, the published JSON schema, and Sources
listing. It does **not** implement the F2 Copse-native event fire sites
(`beforeDiffApply` / `afterDiffApply` / `permissionDecision`) or the F3 sandbox-by-default
spawn reversal — the `sandbox` / `loop_limit` fields are parsed and carried so those phases
can consume them.
