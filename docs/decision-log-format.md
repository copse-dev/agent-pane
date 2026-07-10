# Decision-log on-disk format (v1)

Durable, append-only audit trail of **control-plane decisions** introduced in
[#656](https://github.com/jonathanKingston/agent-pane/issues/656). Where the
[thread store](./thread-store-format.md) records *what the agent did* (tool calls
and their results), this records the permission layer *around* those calls —
tool approvals/denials, the "remember" (sticky-grant) checkbox, sandbox-vs-
external scope classifications, and hook allow/block verdicts — so questions like
"what did I approve, when, at what scope, and did I make it sticky?" survive the
session.

## Location

```
~/.copse/workspace/<projectId>/decisions.jsonl
```

- Same store root as the thread spine; override with `COPSE_WORKSPACE_DIR`
  ([`copse-paths.ts`](../src/main/services/storage/copse-paths.ts)).
- Decisions made with no active project (headless / pre-open paths) are bucketed
  under a `_global` project id so they are never silently dropped.
- Append-only: one JSON object per line
  ([`decision-log.ts`](../src/shared/threads/decision-log.ts)), written through
  the same per-project write queue as the thread store so concurrent gates can't
  interleave a line.

## Line schema (`type: "decision"`)

| field        | type                                                        | notes |
| ------------ | ----------------------------------------------------------- | ----- |
| `v`          | number                                                      | schema version (`1`) |
| `type`       | `"decision"`                                                | discriminator |
| `id`         | string (uuid)                                               | unique per event |
| `at`         | number                                                      | epoch ms |
| `kind`       | string                                                      | domain: `shell` \| `mcp` \| `web` \| `pii` \| `browser` \| `github-write` \| `custom-tool` \| `port-binding` \| `model-compare` \| `install` \| `classification` \| `hook` \| … (free string; treat unknowns gracefully) |
| `actor`      | `"user"` \| `"classifier"` \| `"hook"`                      | who decided |
| `verdict`    | `"approved"` \| `"denied"` \| `"allowed"` \| `"blocked"` \| `"ask"` \| `"timeout"` | `approved`/`denied` are user verdicts; the rest are non-interactive policy/hook verdicts |
| `subject`    | string                                                      | redacted command / tool name / origin |
| `scope`      | string?                                                     | e.g. `sandbox` \| `external` |
| `remembered` | boolean?                                                    | whether the grant was made sticky |
| `confidence` | number?                                                     | classifier confidence in `[0, 1]` |
| `reasons`    | string[]?                                                   | redacted policy / classifier / hook reasons |
| `threadId`   | string?                                                     | originating thread id (links back to the spine) |
| `source`     | string?                                                     | redacted context: hook event name, classifier model, … |

## Where events come from

- **User approvals/denials** — every `requestApproval`
  ([`approval.ts`](../src/main/services/approval.ts)) is recorded as an `actor:
  "user"` event, so all shell / MCP / web / browser / GitHub-write / custom-tool
  / port-binding / PII / model-compare prompts are captured in one place, along
  with the `remember` grant.
- **Classifier verdicts** — the sandbox-vs-external scope classification
  ([`safety-classifier.ts`](../src/main/services/security/safety-classifier.ts))
  is recorded as an `actor: "classifier"` event with `scope` + `confidence`.
- **Hook verdicts** — any non-`allow` Cursor hook decision
  ([`cursor-hooks.ts`](../src/main/services/skills/cursor-hooks.ts)) is recorded
  as an `actor: "hook"` event (`blocked` / `ask`).

## Redaction

Secrets that commonly appear verbatim in recorded commands are stripped at write
time (`redactSecrets`): URL userinfo, `Authorization`/`Bearer` values, known
provider token shapes (`ghp_…`, `sk-…`, `xox…`, `AKIA…`, `AIza…`), and
`*_TOKEN=`/`--password …`-style assignments. Conservative by design — it removes
the obvious secrets, not a guarantee that none ever slips through.

## Machine-readability / provability

Each line is self-describing (carries its own `v` and `type`), and the stream
declares:

- **Media type** — `application/vnd.copse.decision-log+jsonl`
- **Conformance target** — [`draft-vaughan-machine-readability`](https://datatracker.ietf.org/doc/draft-vaughan-machine-readability/)

An **export** (`decisions:export` IPC, or `exportDecisionLog`) writes a
self-contained bundle under `<projectId>/exports/decisions-<timestamp>.jsonl`: a
`decision-log-manifest` header line (media type + schema version + conformance
target + count) followed by the redacted decision events, so external tooling can
validate and evaluate the log on its own rather than merely re-reading it.
