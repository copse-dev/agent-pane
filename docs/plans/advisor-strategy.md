# Advisor strategy

Tracking: [#566](https://github.com/jonathanKingston/agent-pane/issues/566)

Status: **experimental scaffold** — off by default behind the `advisorStrategyEnabled`
setting (Settings → Experimental).

## What this is

Lets the user nominate a larger, higher-intelligence model as an _advisor_ that gives
strategic guidance mid-task, while the everyday loop (the "executor") runs on a
cheaper/faster — ideally on-device / local — model. The advisor reads the full
conversation, produces a plan or course-correction, and the executor keeps doing the work.

This mirrors Anthropic's [Advisor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool),
but as a **client-side** strategy: we run the advisor sub-inference ourselves so _any_
executor (local / OpenAI / OpenRouter / on-device Claude) can consult a large cloud
advisor. The native server-side tool cannot do this — it locks the executor to a Claude
cloud model (Haiku minimum). Delivering the "work done on device + big advisor" goal is
exactly why this is client-side.

## Claude-compatibility contract

We deliberately mirror the native tool's observable behaviour so a future switch to the
real `advisor_20260301` server tool (for Claude-cloud executors) is a drop-in with no
behavioural change:

- **No-parameter tool.** The `advisor` tool takes no arguments; the executor's full
  transcript is forwarded automatically (client-side we read the live loop transcript).
- **Result shape.** Advice is normalized into the native `advisor_result` `{ text,
stop_reason? }` union, with an `advisor_redacted_result` branch reserved for parity.
- **Bare advisor.** The advisor runs with no tools and no context management; only the
  advice text reaches the executor.
- **Truncation marker.** On a `max_tokens` stop the rendered advice carries the same
  `[Advisor output truncated at max_tokens=…]` marker the native API appends.
- **Native compatibility table** is encoded so the UI can flag when a Claude/Claude
  pairing would also be valid for the native server tool.

## What landed in this scaffold

- **Settings** `advisorStrategyEnabled` (experimental, default off) and `advisorModel`
  (default `claude-opus-4-8`) — schema in `settings-writable.ts`, UI in the Experimental
  section of `settings-dialog.ts`.
- **Core** `src/main/services/advisor-strategy.ts` — pure: Claude-compatible result types
  and `normalizeAdvisorResult()` / `renderAdvisorResult()`, `buildAdvisorTranscript()`,
  and `isNativeAdvisorPair()` / `validateAdvisorPair()` from the native compatibility table.
- **Runner** `src/main/services/advisor-runner.ts` — run-scoped context (set by
  `agent-service.ts` around an `advisor` call, mirroring the explore subagent seam) that
  reads the live transcript, builds the advisor provider via `buildProvider`, runs a bare
  one-shot inference with `completeTextWithUsage`, and returns the normalized advice.
- **Tool** `advisor` (`src/main/tools/advisor-tool.ts`) — no parameters; registered only
  when the flag is on (`registry-bootstrap.ts`).
- **Tests** `advisor-strategy.test.ts` (transcript formatting, result normalization/render,
  native-pair validation).

While the flag is off, nothing is registered and no advisor call is ever made.

## Annotation-driven pair assessment (landed after the scaffold)

The model-annotation work (`docs/plans/model-roles-and-defaults.md`) feeds the advisor
strategy in three ways:

- **`advisor` is a first-class agent role** (`packages/llm/src/agent-roles.ts`), so the
  role indirection layer covers it: assigning a model to the `advisor` role in the
  `roleModels` setting overrides the legacy `advisorModel` setting
  (`ROUTED_SETTING_TO_ROLE` in `role-models.ts`, read by `resolveAdvisorModelId()`).
- **Cloud capability tiers** (`packages/llm/src/model-tiers.ts`) annotate every tracked
  cloud model as `fast` / `balanced` / `frontier`. The model classifier's representative
  tier models now derive from the same annotations instead of a private copy.
- **`validateAdvisorPair()` grades pairings from the annotations**, not just the native
  table: local executor + frontier cloud advisor is flagged as the recommended pairing;
  cloud/cloud pairings compare tiers (a weaker-tier advisor warns); local advisors
  compare catalog sizing (`paramsB`) when both models are catalogued and warn otherwise.
  Each assessment carries a `level` (`good` / `info` / `warn`) that the settings UI
  renders live under the advisor picker (`#advisorPairHint`), re-grading when either the
  chat model or advisor model changes. Unannotated models (OpenRouter / ACP /
  uncatalogued ids) stay on the permissive generic note — the annotations steer, they
  never block.

Visual eval: `tests/e2e/advisor-pair-hint.e2e.ts` (screenshots
`advisor-pair-hint-good.png` / `advisor-pair-hint-warn.png`).

## Deliberately out of scope (follow-ups on #566)

- **Native `advisor_20260301` server tool** for Claude-cloud executors: attach the tool
  block + `advisor-tool-2026-03-01` beta header in `AnthropicProvider`, parse
  `server_tool_use` / `advisor_tool_result` stream blocks, and handle `pause_turn`
  resumption. Should slot in behind the same internal contract with no behavioural change.
- **Dedicated advisor cost line.** Advisor tokens currently fold into the run's aux-model
  usage (via `addSubagentUsage`). Split them onto their own line, mirroring the native
  `usage.iterations[].advisor_message`, billed at the advisor model's rate.
- ~~**Model picker UI** for the advisor (today a text field) and pair-validation
  surfacing.~~ Done: picker in #572; annotation-driven pair assessment surfaced live in
  settings (see above).
- **Prompting/timing** — the docs' suggested system-prompt blocks and turn-2 nudge for
  under-calling (esp. small/local) executors; a per-conversation advisor-call cap and
  advisor-side prompt caching.
