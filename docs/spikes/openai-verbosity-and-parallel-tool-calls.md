# OpenAI `verbosity` and `parallel_tool_calls`

Status: `verbosity` is a supported, opt-in tunable with **no default**; `parallel_tool_calls` is
deliberately **not sent**. Checked against OpenAI's docs on 2026-09-30.

## `verbosity`

Wire shape: Responses `text: { verbosity }`, Chat Completions top-level `verbosity`
(`low | medium | high`, server default `medium`). Sending `text` to Chat Completions, or the
top-level field to Responses, is a 400.

Support (`modelParameterSupport().verbosity`, an allowlist, not inferred):

| Route                                             | Verbosity                                                                                                                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First-party `gpt-5*`, `gpt-6*`                    | low / medium / high                                                                                                                                                                                                 |
| `*-codex`                                         | **none**. Accepts only `medium`; `low` is `400 Unsupported value … param text.verbosity` ([openai/codex#6004](https://github.com/openai/codex/issues/6004), [#19188](https://github.com/openai/codex/issues/19188)) |
| `-chat`, `search` snapshots                       | none until confirmed                                                                                                                                                                                                |
| o-series, `gpt-4*`                                | none (predates the parameter)                                                                                                                                                                                       |
| Anthropic, OpenRouter, LM Studio, extra providers | none. Not OpenAI's endpoint; unknown body fields are rejected or dropped                                                                                                                                            |

Other findings:

- OpenAI lists `verbosity_changed` as a prompt-cache miss reason, so the level must be constant
  for a thread. It is a per-model setting, never varied per turn.
- `text.verbosity` and `text.format` share the `text` object. Copse sends no `text.format`
  (first-party function tools use their separate strict schema contract), so there is no conflict. `extraBody` is spread last
  and replaces the whole `text` object if a user sets one.
- OpenAI's guidance: GPT-5.6 is already more concise than 5.5 by default; for coding, `low`
  "keeps the answer tighter and more minimal" while medium/high give more organised output.
  It also says to check that broad "Be concise" prompts still help. Copse's system prompt should
  be reviewed the same way before a default is chosen.

### Why there is no default

A curated default needs a checked-in evidence record (see `RECOMMENDATIONS` in
`model-parameters.ts`), and this change has none: the live comparison could not be run because the
session had no `OPENAI_API_KEY`. Shipping `low` on intuition would risk truncating the final
summaries the UI relies on, and the vendor docs do not recommend a value for coding agents.
Untouched models therefore send nothing (asserted in `model-parameters.test.ts`).

### Measurement protocol for choosing a default

Same model (`gpt-6.1-sol`, then `gpt-5.6-terra`), same reasoning effort, same prompt cache
state (fresh thread per run), `low` vs `medium`, ≥5 runs per cell over 3–4 scripted coding tasks
(fix a failing test, small refactor, explain-a-module, multi-file edit):

- output tokens and cost per task (usage ledger),
- task success (the task's own test/assert),
- final-message completeness: does it still state what changed and what was verified?

Decide per context if they diverge: main agent, subagents (their output is consumed as a tool
result, so terse is likely fine), and the reviewer (needs findings in full).

## `parallel_tool_calls`

Decision: **send nothing.**

- API default is `true`; `false` means "zero or one tool call per turn". Documented caveats are
  narrow: fine-tuned models with `strict: true`, and a `gpt-4.1-nano` snapshot. Copse opts
  first-party OpenAI into strict function tools per tool, with raw non-strict fallback when the
  conservative schema transformer cannot safely convert a schema. Compatible routes remain
  non-strict.
- The agent loop (`executeToolBatch` in `packages/agent/src/run-agent-loop.ts`) already runs a
  batch's calls **sequentially in order**, including mutating tools and approval prompts. The only
  concurrency is a leading run of read-only `explore` subagents (`EXPLORE_PARALLELISM`).
  Concurrent unsafe execution therefore cannot happen, and `false` would only add round trips.
- Reasoning replay is keyed to the first call of a batch and replayed once ahead of all its calls
  (`toResponsesInput`; test "replays one reasoning block once for a parallel batch"), so parallel
  batches are handled correctly.
- Tests pin that neither transport sends the field.

Revisit if the loop starts executing a batch concurrently with mutating tools, or if a model is
found to emit duplicate calls for one tool.
