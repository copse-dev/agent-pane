# Model classifier

Tracking: [#557](https://github.com/jonathanKingston/agent-pane/issues/557)

Status: **experimental scaffold** — off by default behind the `modelClassifierEnabled`
setting (Settings → Experimental).

## What this is

A classifier that, given a task, recommends which model is the best fit — so cheap/fast
models handle trivial work (renames, summaries) and frontier models are reserved for the
hard tasks (refactors, debugging, planning). Copse already reaches many providers/models
that differ in capability, cost, latency, and context window; picking well per-task is a
real lever on quality and spend.

## What landed in this scaffold

- **Setting** `modelClassifierEnabled` (experimental, default off) — schema in
  `settings-writable.ts`, UI in the Experimental section of `settings-dialog.ts`.
- **Classifier** `src/main/services/model-classifier.ts` — a pure `classifyModelForTask()`
  heuristic returning `{ tier, model, confidence, rationale }`. Tiers are `fast` /
  `balanced` / `frontier`, mapped to representative tracked-catalog models
  (`claude-haiku-4-5` / `claude-sonnet-4-6` / `claude-opus-4-8`). Signals: keyword hints,
  prompt length, context-window need, and whether the task is agentic.
- **Tool** `suggest_model` (`src/main/tools/model-classifier-tool.ts`) — advisory; returns
  the recommendation. Registered only when the flag is on (`registry-bootstrap.ts`).
- **Tests** `model-classifier.test.ts`.

The tool is advisory only and the classifier is pure — while the flag is off nothing is
registered and the model in use is never changed.

## Not yet built (follow-ups on the issue)

- **Wire into provider selection** — feed the recommendation into the real model-routing
  path (`provider-selection.ts`, the existing small-tasks / subagent routing) instead of
  a standalone advisory tool, with a user override that shows _why_.
- **Map tiers to configured/available providers** — today the mapping is Anthropic-only;
  respect which providers have keys, cost/latency preferences, and on-device-only
  constraints (cf. #518).
- **Better classifier** — replace the heuristic with a small local model or a cheap
  model-judge, and add a feedback loop (did the chosen model succeed or need escalation?).
- Source per-model pricing/latency metadata for cost-aware routing.
