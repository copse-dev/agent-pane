# Decision-log on-disk format (v1)

Durable, append-only audit trail of **control-plane decisions** introduced in
[#656](https://github.com/copse-dev/agent-pane/issues/656). Where the
[thread store](./thread-store-format.md) records _what the agent did_ (tool calls
and their results), this records the permission layer _around_ those calls —
tool approvals/denials, the "remember" (sticky-grant) checkbox, sandbox-vs-
external scope classifications, and hook allow/block verdicts — so questions like
"what did I approve, when, at what scope, and did I make it sticky?" survive the
session.

## Location

Decisions are **thread-local spine lines** on each thread's `events.jsonl`:

```
~/.copse/workspace/<projectId>/<threadId>/events.jsonl
```

Optional argv / Guarded-YOLO extras live next to tool results:

```
~/.copse/workspace/<projectId>/<threadId>/blobs/decision-<id>.detail.json
```

- Same store root as the rest of the thread; override with `COPSE_WORKSPACE_DIR`
  ([`copse-paths.ts`](../src/main/services/storage/copse-paths.ts)).
- A writer names the project, or records inside the thread's own turn, whose
  project is then used. It never falls back to the window's active project.
  Decisions without a project **and** thread are dropped (there is no `_global`
  bucket).
- Append-only: one JSON object per line
  ([`decision-log.ts`](../src/shared/threads/decision-log.ts) +
  [`spine-schema.ts`](../src/shared/threads/spine-schema.ts)), written through
  the same per-project write queue as the thread store.
- Legacy project-level `decisions.jsonl` is no longer written; readers delete it
  when encountered. Older `permission_decision` spine lines remain readable.

## Line schema (`type: "decision"`)

| field                          | type                                                                                                                                                  | notes                                                                                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `v`                            | number                                                                                                                                                | schema version (`1`)                                                                                                                                                                                                     |
| `type`                         | `"decision"`                                                                                                                                          | discriminator                                                                                                                                                                                                            |
| `id`                           | string (uuid)                                                                                                                                         | unique per event                                                                                                                                                                                                         |
| `at`                           | number                                                                                                                                                | epoch ms                                                                                                                                                                                                                 |
| `kind`                         | string                                                                                                                                                | domain: `shell` \| `mcp` \| `web` \| `pii` \| `browser` \| `github-write` \| `custom-tool` \| `port-binding` \| `model-compare` \| `install` \| `classification` \| `hook` \| … (free string; treat unknowns gracefully) |
| `actor`                        | `"user"` \| `"classifier"` \| `"hook"` \| `"system"`                                                                                                  | who produced the event                                                                                                                                                                                                   |
| `verdict`                      | `"approved"` \| `"denied"` \| `"allowed"` \| `"blocked"` \| `"ask"` \| `"classified"` \| `"timeout"` \| `"cancelled"` \| `"deferred"` \| `"observed"` | `classified` records evidence rather than authorization; timeout/window-close/unavailable transport outcomes are system events, not user denials                                                                         |
| `subject`                      | string                                                                                                                                                | redacted operation / tool name / origin; shell arguments are omitted                                                                                                                                                     |
| `scope`                        | string?                                                                                                                                               | e.g. `sandbox` \| `external`                                                                                                                                                                                             |
| `remembered`                   | boolean?                                                                                                                                              | whether the grant was made sticky                                                                                                                                                                                        |
| `confidence`                   | number?                                                                                                                                               | classifier confidence in `[0, 1]`                                                                                                                                                                                        |
| `reasons`                      | string[]?                                                                                                                                             | redacted policy / classifier / hook reasons                                                                                                                                                                              |
| `threadId`                     | string?                                                                                                                                               | originating thread id                                                                                                                                                                                                    |
| `toolCallId`                   | string?                                                                                                                                               | join key to the tool call whose args live inline or in the blob its spine `args` ref names                                                                                                                               |
| `source`                       | string?                                                                                                                                               | redacted context: hook event name, classifier model, …                                                                                                                                                                   |
| `cause`                        | string?                                                                                                                                               | fixed prompt-cause slug ([`prompt-cause.ts`](../src/shared/threads/prompt-cause.ts))                                                                                                                                     |
| `latencyMs`                    | number?                                                                                                                                               | wall-clock time a classifier took to answer; set only on `classifier-call` events                                                                                                                                        |
| `inputTokens` / `outputTokens` | number?                                                                                                                                               | tokens the classifier's own call consumed, when the engine reported them; `classifier-call` events only                                                                                                                  |
| `detail`                       | `{ ref, sha256 }`?                                                                                                                                    | optional blob for YOLO command text / other structured extras (not inlined into exports)                                                                                                                                 |
| `turnId`                       | string?                                                                                                                                               | hook-recording turn correlation                                                                                                                                                                                          |
| `step`                         | number?                                                                                                                                               | hook-recording step                                                                                                                                                                                                      |
| `principalId`                  | string?                                                                                                                                               | principal the line is bound to: `human:local`, or `automation:<scheduleId>@<triggeredAt>` for a corroborated scheduled run. Set on every decision recorded inside a turn                                                 |
| `principalKind`                | `"human"` \| `"automation"` \| `"provider-managed"`?                                                                                                  | kind of `principalId`                                                                                                                                                                                                    |
| `runtime`                      | string?                                                                                                                                               | runtime profile: `local/contained`, `local/host` or `ssh:<hostId>`; execution lines only                                                                                                                                 |
| `processRunId`                 | string?                                                                                                                                               | joins a `process-run` line to its `process-exit` line                                                                                                                                                                    |
| `exitCode` / `exitSignal`      | number? / string?                                                                                                                                     | `process-exit` only: exit code, or the signal that ended the process                                                                                                                                                     |
| `capabilities`                 | object?                                                                                                                                               | `runtime-state` only: the profile's capability snapshot (`ExecutionRuntimeCapabilities`)                                                                                                                                 |

## Where events come from

- **User approvals/denials** — every `requestApproval`
  ([`approval.ts`](../src/main/services/approval.ts)) is recorded as an `actor:
  "user"` event, so all shell / MCP / web / browser / GitHub-write / custom-tool
  / port-binding / PII / model-compare prompts are captured in one place, along
  with the `remember` grant.
- **Guarded YOLO** — shell authorizations write the same `decision` line (cause
  `shell-guarded-yolo-harm`) with command text in the detail blob rather than a
  separate `permission_decision` line type.
- **Classifier evidence** — the sandbox-vs-external scope classification
  ([`safety-classifier.ts`](../src/main/services/security/safety-classifier.ts))
  is recorded as an `actor: "classifier"`, `verdict: "classified"` event with
  `scope` + `confidence`; it does not claim the classifier authorized execution.
- **Classifier unavailability** — when the configured safety model cannot
  screen (`not-available`: not offered by the local server; `server-unreachable`;
  or `timed-out`: present, but unable to answer inside the screening budget),
  that is recorded once per thread and reason
  ([`safety-model-availability.ts`](../src/main/services/security/safety-model-availability.ts))
  as an `actor: "system"`, `verdict: "ask"` event whose `subject` is
  `safety-model` and whose single reason reads `<reason>: <model>`. It is
  deliberately not `classified` — nothing was classified — and not a user
  denial: it records that screening was unavailable, so a run of approval
  prompts is explained rather than looking like a flaky model. Deduped per
  thread because it is a standing fault, not a per-call event. A `timed-out`
  line also explains a _change_ of model — the too-slow one is routed around for
  a few minutes and screening moves to the next candidate
  ([`safety-model-cooldown.ts`](../src/main/services/security/safety-model-cooldown.ts)),
  so a later `classified` event on the same thread may name a model the settings
  do not; that skip is in memory, expires on its own, and is never persisted.
- **Classifier calls** — every engine call by the safety screening (the
  shell-scope guard and the terminal-read screen, whether the safety model or a
  classifier connection answers) and by the shell-tier checks is recorded as
  one `kind: "classifier-call"`, `actor: "classifier"` event
  ([`classifier-call-log.ts`](../src/main/services/security/classifier-call-log.ts)).
  `subject` is what was screened (`shell-scope`, `shell-tier` or
  `terminal-read`), `source` is the model or classifier connection that
  answered, and `scope` is its verdict label (`sandbox`, `external`, `safe`,
  `risky`, a tier name). `verdict` is `classified` when it gave one, `timeout`
  when it ran out of its budget and `ask` when it answered nothing usable (no
  `scope`). `latencyMs`, `inputTokens` and `outputTokens` are set when known. A
  call that never reached an engine — screening off, no model, a cooldown — is
  not recorded. These are telemetry, separate from the `classification` events
  above, which record a verdict the gate acted on; counting only this kind
  reports one screening once. `usage:get-thread-classifier-use` summarizes them
  per thread for the footer hover. No command or snapshot text is recorded.
- **Execution audit** — every agent command (a `run_shell` or `run_background` command, or a hook
  command) that an `ExecutionRuntime` adapter starts inside an
  agent turn ([`execution-runtime/`](../src/main/services/execution-runtime/), plan
  [R1](plans/execution-runtime-security.md#r1--runtime-contract-and-always-on-audit))
  writes a `kind: "process-run"` line when it starts and a `kind: "process-exit"` line
  when it ends. Both lines are `actor: "system"`, `verdict: "observed"`, and they share a
  `processRunId`. Each names the `runtime` profile and the principal; `scope` is
  `sandbox` for a contained local process and `external` otherwise. The subject is
  `shell command (arguments omitted)`, so neither line records arguments. The first use of a runtime profile in a thread during a session also
  writes a `kind: "runtime-state"` line with its `capabilities`. `observed` records an
  effect, not an authorization. Processes Copse starts through `spawnInProjectSandbox`
  are not recorded, even when they run inside a turn's async context. These are Git
  reads, the sandbox file worker, probes, the plugin tool worker, Apple development
  commands and app runs. A probe outliving its turn must not append to an idle thread's
  spine. Some of these start because an agent called a tool (a plugin tool, an Apple
  build, an app run), so this is a known gap in the audit, not a claim that they are
  never the agent's actions. Processes outside a turn are not recorded. Interactive terminals are not recorded yet either. Headless and
  container runs record the same lines into the run's own decision list. The Context panel's
  Recent decisions list leaves `observed` lines out; the export keeps them.
- **Hook verdicts** — any non-`allow` Cursor hook decision
  ([`cursor-hooks.ts`](../src/shared/types/cursor-hooks.ts)) is recorded
  as an `actor: "hook"` event (`blocked` / `ask`).

## Redaction

Shell decisions record the fixed subject `shell command (arguments omitted)`;
raw command text is never inlined on the spine line because arbitrary positional
secrets cannot be redacted reliably. Prefer joining via `toolCallId` to tool
args (inline or the blob the tool call's `args` ref names). Guarded YOLO still stores commands in
the optional detail blob for forensics. Other free-text fields are passed through
`redactSecrets`, which strips URL userinfo, `Authorization`/`Bearer` values,
known provider token shapes (`ghp_…`, `sk-…`, `xox…`, `AKIA…`, `AIza…`), and
`*_TOKEN=`/`--password …`-style assignments as defense in depth.

## Machine-readability / provability

Each line is self-describing (carries its own `v` and `type`), and the stream
declares:

- **Media type** — `application/vnd.copse.decision-log+jsonl`
- **Conformance target** — [`draft-vaughan-machine-readability`](https://datatracker.ietf.org/doc/draft-vaughan-machine-readability/)

An **export** (`decisions:export` IPC, or `exportDecisionLog`) writes a
self-contained bundle under `<projectId>/exports/decisions-<timestamp>.jsonl`: a
`decision-log-manifest` header line (media type + schema version + conformance
target) followed by redacted decision events gathered from every thread spine in
the project. Detail blobs are not inlined.
