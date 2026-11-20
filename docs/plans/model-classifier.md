# Model classifier

Tracking: [#557](https://github.com/copse-dev/agent-pane/issues/557) (closed); follow-ups in
[#4001](https://github.com/copse-dev/agent-pane/issues/4001)

Status: **primary prompt routing plus an experimental advisory tool**.

## Primary agent: Match task

Choose **Match task** in the chat model picker or as the default chat model.
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

This applies only to primary turns. Subagent routing is unchanged: it uses the
Research role model chosen in Settings, so connecting it to the assessment is follow-up
work. The experimental `suggest_model` tool shares the same assessment and the same
configured, policy-filtered pool (below). Primary automatic routing does not require the
experimental advisory-tool toggle.

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
  (`BAND_REPRESENTATIVE_MODEL` in `model-intellect.ts`) provides a fallback. Candidates in
  each band are the shipped catalog models (`TRACKED_MODELS`), ranked by LiteLLM catalog
  pricing and filtered by context-window fit, keeping cost as a separate axis from
  intellect. Signals: keyword hints, prompt length, context-window need, and whether the
  task is agentic.
- **Tool** `suggest_model` (`src/main/tools/model-classifier-tool.ts`) — advisory. It
  assesses the task with Match task's chain (Background questions classifier → Small
  tasks → chat-model backup → the heuristic above) and recommends from the same
  configured, policy-filtered pool with the same ranking (`recommendTaskModel` in
  `prompt-model-routing.ts`), skipping routes smaller than `contextTokensEstimate`. It
  never names a model whose provider is not configured. With an empty pool, or no route
  wide enough, it recommends none; when nothing meets the demand floor it names the
  strongest configured model and says it is below the floor, as Match task would choose.
  The assessment may call a hosted classifier or Small tasks route, like Match task.
  Registered only when the flag is on (`registry-bootstrap.ts`).
- **Tests** `model-classifier.test.ts`.

The tool is advisory only and the classifier is pure — while the flag is off nothing is
registered and the model in use is never changed.

## Not yet built (follow-ups on the issue)

- **Share the model-based assessment with subagent routing**. Primary routing and
  `suggest_model` already map the band's intellect floor onto the configured,
  policy-filtered model pool (see [Primary agent](#primary-agent-match-task)); subagents
  still use the Research role's chosen model.
- **Feedback loop** — measure whether the chosen primary model succeeds or needs escalation.
- Add latency metadata alongside pricing for latency-aware routing.

See [`model-roles-and-defaults.md`](./model-roles-and-defaults.md) for a broader proposal
that generalizes tiers into a full role registry (coder, reviewer, security-auditor, …), a
benchmark-backed capability catalog, and data-derived defaults — the classifier becomes the
runtime that routes a task onto a role.
