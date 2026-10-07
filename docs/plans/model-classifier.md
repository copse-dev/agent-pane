# Model classifier

Tracking: [#557](https://github.com/copse-dev/agent-pane/issues/557)

Status: **primary prompt routing plus an experimental advisory tool**.

## Primary agent: Auto — match prompt

Choose **Auto — match prompt** in the chat model picker or as the default chat model.
On the first ask in a new chat, after submission hooks and PII redaction, Copse asks
the classifier selected under **Settings → Classifiers → Background questions**
to assess that request. If none is selected or it cannot answer, Copse tries the
Small tasks model (local Gemma by default), then its chat-model backup. The assessment has a
five-second inference budget per route and returns low, mid, or
top demand. Each level uses the shared representative model's Intelligence Index
score as a capability floor. This is an estimate, not a measured guarantee of task success.

Copse selects a route from the existing available-model pool, respecting its provider,
maker, privacy, and plan-coverage filters. It prefers included capacity meeting the
floor, otherwise the cheapest qualifying route. Equally priced routes are ranked by
the lowest sufficient intelligence, so included capacity does not always select the
strongest subscription model. When nothing meets the floor it uses the strongest
available model. If the first assessment route fails or returns an invalid answer,
Copse tries the configured backup. When no assessor can answer (including ACP-only
setups without a one-shot provider), the existing task heuristic estimates demand.
This fallback still distinguishes a README typo check from difficult debugging.

Routing produces no assistant message: the chosen model is shown in the picker,
and diagnostic details go to the application log. The chosen model becomes the chat's fixed
model in both live state and persisted metadata. Later asks reuse it without another
assessment. The user can still select another model manually. Opening a blank chat
does not resolve the automatic choice before the first ask. Assessment uses the configured
classifier and model fallback routes, so hosted routes receive the bounded context
and may incur a small additional charge. Assessment token usage is recorded.

This applies only to primary turns. Subagent routing is unchanged. The existing
`suggest_model` tool remains the heuristic advisory implementation below; connecting
it and subagent selection to the new assessment is follow-up work. Primary automatic
routing does not require the experimental advisory-tool toggle.

## What this is

A classifier that, given a task, recommends which model is the best fit — so cheap/fast
models handle trivial work (renames, summaries) and frontier models are reserved for the
hard tasks (refactors, debugging, planning). Copse already reaches many providers/models
that differ in capability, cost, latency, and context window; picking well per-task is a
real lever on quality and spend.

## What landed in this scaffold

- **Setting** `modelClassifierEnabled` (experimental, default off) — schema in
  `settings-writable.ts`, UI in the Experimental section of `settings-dialog.ts`.
- **Classifier** `src/main/services/providers/model-classifier.ts` — a pure
  `classifyModelForTask()` heuristic returning `{ band, intellect, model, confidence,
rationale }`. Task demand is expressed on the app's shared **model intellect scale**
  (`packages/llm/src/model-intellect.ts`, see
  [`advisor-strategy.md`](./advisor-strategy.md)): bands `low` / `mid` / `top` are
  derived from the annotated distribution, and each band's representative model
  (`BAND_REPRESENTATIVE_MODEL`: `claude-haiku-4-5` / `claude-sonnet-4-6` /
  `claude-opus-4-8`) provides a fallback. Candidates in each band are ranked by
  LiteLLM catalog pricing and filtered by context-window fit, keeping cost as a
  separate axis from intellect. Signals: keyword hints, prompt length,
  context-window need, and whether the task is agentic.
- **Tool** `suggest_model` (`src/main/tools/model-classifier-tool.ts`) — advisory; returns
  the recommendation including its estimated catalog rate. Registered only when
  the flag is on (`registry-bootstrap.ts`).
- **Tests** `model-classifier.test.ts`.

The tool is advisory only and the classifier is pure — while the flag is off nothing is
registered and the model in use is never changed.

## Not yet built (follow-ups on the issue)

- **Share the model-based assessment with the advisory tool and subagent routing**.
- **Map band representatives to configured/available providers** — today the mapping is
  Anthropic-only; respect which providers have keys, cost/latency preferences, and
  on-device-only constraints (cf. #518).
- **Feedback loop** — measure whether the chosen primary model succeeds or needs escalation.
- Add latency metadata alongside pricing for latency-aware routing.

See [`model-roles-and-defaults.md`](./model-roles-and-defaults.md) for a broader proposal
that generalizes tiers into a full role registry (coder, reviewer, security-auditor, …), a
benchmark-backed capability catalog, and data-derived defaults — the classifier becomes the
runtime that routes a task onto a role.
