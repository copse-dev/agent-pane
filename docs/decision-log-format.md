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
- Decisions without an active project **and** thread are dropped (there is no
  `_global` bucket).
- Append-only: one JSON object per line
  ([`decision-log.ts`](../src/shared/threads/decision-log.ts) +
  [`spine-schema.ts`](../src/shared/threads/spine-schema.ts)), written through
  the same per-project write queue as the thread store.
- Legacy project-level `decisions.jsonl` is no longer written; readers delete it
  when encountered. Older `permission_decision` spine lines remain readable.

## Line schema (`type: "decision"`)

| field        | type                                                                                                                                  | notes                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `v`          | number                                                                                                                                | schema version (`1`)                                                                                                                                                                                                     |
| `type`       | `"decision"`                                                                                                                          | discriminator                                                                                                                                                                                                            |
| `id`         | string (uuid)                                                                                                                         | unique per event                                                                                                                                                                                                         |
| `at`         | number                                                                                                                                | epoch ms                                                                                                                                                                                                                 |
| `kind`       | string                                                                                                                                | domain: `shell` \| `mcp` \| `web` \| `pii` \| `browser` \| `github-write` \| `custom-tool` \| `port-binding` \| `model-compare` \| `install` \| `classification` \| `hook` \| … (free string; treat unknowns gracefully) |
| `actor`      | `"user"` \| `"classifier"` \| `"hook"` \| `"system"`                                                                                  | who produced the event                                                                                                                                                                                                   |
| `verdict`    | `"approved"` \| `"denied"` \| `"allowed"` \| `"blocked"` \| `"ask"` \| `"classified"` \| `"timeout"` \| `"cancelled"` \| `"deferred"` | `classified` records evidence rather than authorization; timeout/window-close/unavailable transport outcomes are system events, not user denials                                                                         |
| `subject`    | string                                                                                                                                | redacted operation / tool name / origin; shell arguments are omitted                                                                                                                                                     |
| `scope`      | string?                                                                                                                               | e.g. `sandbox` \| `external`                                                                                                                                                                                             |
| `remembered` | boolean?                                                                                                                              | whether the grant was made sticky                                                                                                                                                                                        |
| `confidence` | number?                                                                                                                               | classifier confidence in `[0, 1]`                                                                                                                                                                                        |
| `reasons`    | string[]?                                                                                                                             | redacted policy / classifier / hook reasons                                                                                                                                                                              |
| `threadId`   | string?                                                                                                                               | originating thread id                                                                                                                                                                                                    |
| `toolCallId` | string?                                                                                                                               | join key to the tool call whose args live inline or in `blobs/<id>.args.json`                                                                                                                                            |
| `source`     | string?                                                                                                                               | redacted context: hook event name, classifier model, …                                                                                                                                                                   |
| `cause`      | string?                                                                                                                               | fixed prompt-cause slug ([`prompt-cause.ts`](../src/shared/threads/prompt-cause.ts))                                                                                                                                     |
| `detail`     | `{ ref, sha256 }`?                                                                                                                    | optional blob for YOLO command text / other structured extras (not inlined into exports)                                                                                                                                 |
| `turnId`     | string?                                                                                                                               | hook-recording turn correlation                                                                                                                                                                                          |
| `step`       | number?                                                                                                                               | hook-recording step                                                                                                                                                                                                      |

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
- **Classifier unavailability** — when the configured safety model cannot run
  at all (not offered by the local server, or the server is unreachable), that
  is recorded once per thread
  ([`safety-model-availability.ts`](../src/main/services/security/safety-model-availability.ts))
  as an `actor: "system"`, `verdict: "ask"` event whose `subject` is
  `safety-model`. It is deliberately not `classified` — nothing was classified
  — and not a user denial: it records that screening was unavailable, so a run
  of approval prompts is explained rather than looking like a flaky model.
  Deduped per thread because it is a configuration fault, not a per-call event.
- **Hook verdicts** — any non-`allow` Cursor hook decision
  ([`cursor-hooks.ts`](../src/shared/types/cursor-hooks.ts)) is recorded
  as an `actor: "hook"` event (`blocked` / `ask`).

## Redaction

Shell decisions record the fixed subject `shell command (arguments omitted)`;
raw command text is never inlined on the spine line because arbitrary positional
secrets cannot be redacted reliably. Prefer joining via `toolCallId` to tool
args (inline or `blobs/<id>.args.json`). Guarded YOLO still stores commands in
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
