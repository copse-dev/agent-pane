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

- **No-argument call stays native-compatible.** The native `advisor_20260301` tool takes
  no arguments; a bare `advisor()` call here behaves identically — the full transcript is
  forwarded automatically (client-side we read the live loop transcript). We add two
  **optional** client-side parameters that only ever _add_ focus/context, never withhold
  it, so the no-arg form remains a drop-in: `question` (the executor's specific ask,
  appended after the transcript) and `include_diff` (attach the verified working-tree
  diff). A future switch to the native server tool simply ignores/strips them. We
  deliberately do **not** let the executor _reduce_ the forwarded context: it is the
  party that is stuck, and withholding state is exactly what caused the repo-state
  hallucination the verified-context block fixes — so context is full by default and the
  executor can only enrich it.
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
- **Tool** `advisor` (`src/main/tools/advisor-tool.ts`) — optional `question` /
  `include_diff` params (the no-arg call is native-compatible); registered only when the
  flag is on (`registry-bootstrap.ts`).
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
- **An open-ended cloud intellect scale** (`packages/llm/src/model-intellect.ts`)
  annotates every tracked cloud model with an ordinal capability number. A scalar, not
  named tiers, because "frontier" is a moving target and static tier labels rot: a new
  frontier model _extends the top of the scale_ (e.g. a next-generation model lands at
  10, its successor at 11) and existing entries are never re-numbered, so relative
  comparisons stay correct forever. Top/mid/low bands are derived from the annotated
  distribution (`intellectBand`) and re-band automatically when the scale grows. Cost
  is deliberately a separate axis — pricing stays on the LiteLLM-synced catalog and
  never feeds the intellect numbers. **The scale is the app's single capability
  vocabulary**: the model classifier (`suggest_model`, issue #557) places task demand
  on the same scale (its per-band representative models live in
  `BAND_REPRESENTATIVE_MODEL`, scale-validated in tests so extending the scale forces
  the picks to be revisited), and roadmap complexity maps bands → low/medium/high.
- **A confidently-weaker advisor hides the tool.** `advisorAddsLift(executor, advisor)`
  returns `false` only on same-scale certainty — the same model on both sides, an
  annotated cloud advisor with lower intellect, or a catalogued local advisor with fewer
  params — and `parentTools` drops the `advisor` tool from the executor's toolset in that
  case, so a stronger model never wastes a call on a weaker advisor. Cross-scale (local
  advisor vs cloud executor) and unannotated pairings keep the tool (hiding is stricter
  than the settings `warn`, so it only fires when certain); ACP executors are unannotated
  so the tool is never hidden for them. The settings hint says when a pairing hides it.
- **`validateAdvisorPair()` grades pairings from the annotations**, not just the native
  table: local executor + top-of-scale cloud advisor is flagged as the recommended
  pairing; cloud/cloud pairings compare intellect numbers (a weaker-annotated advisor
  warns); local advisors compare catalog sizing (`paramsB`) when both models are
  catalogued and warn otherwise. Each assessment carries a `level`
  (`good` / `info` / `warn`) that the settings UI renders live under the advisor picker
  (`#advisorPairHint`), re-grading when either the chat model or advisor model changes.
  Unannotated models (OpenRouter / newer cloud ids / uncatalogued models) get a
  positive client-side note — this is a full client-side implementation, so **any**
  executor/advisor pairing works; the annotations steer, they never block. Native
  compatibility is mentioned only as a bonus on Claude/Claude pairs, never as a
  limitation elsewhere.
- **ACP works both ways.** _As the advisor:_ an `acp:<id>` advisor selection routes the
  consultation through `acp-advisor.ts` — a throwaway, bare ACP session (no MCP
  servers, no native-tool bridge, no fs handlers, every permission request
  auto-rejected) that forwards the transcript prompt and returns the agent's text as
  the advice. One-shot by design: the advisor must never touch the executor thread's
  pooled ACP session. Loopback-tested in `acp-advisor.test.ts`. _As the executor:_ the
  `advisor` tool is offered over the native-tool MCP bridge (`acp-native-bridge.ts`),
  and agent-service scopes an advisor context to the whole ACP turn (bridged calls
  arrive over HTTP at any point, unlike the native loop's per-call scoping). The
  transcript the advisor sees is Copse's view: prior thread history, the turn's user
  prompt, and the assistant text streamed so far — the external agent's internal tool
  activity is not visible to Copse and so not forwarded. Known limitation (same as the
  other global-slot contexts): two ACP turns running concurrently in different threads
  would contend for the advisor context slot.

Visual eval: `tests/e2e/advisor-pair-hint.e2e.ts` (screenshots
`advisor-pair-hint-good.png` / `advisor-pair-hint-warn.png`).

### Context passing (transcript + verified repo state)

The advisor is handed two things: the executor's transcript and a verified
repo-state block. `buildAdvisorTranscript()` formats the live message array
(system prompt, user turns, assistant text, assistant tool _calls_, and tool
_results_) — the client-side equivalent of what Anthropic's native advisor tool
quotes automatically (system prompt + tool defs + prior turns + tool results).

The transcript alone is a lossy, sometimes context-trimmed _narration_ of what
the executor did, not what the repo _is_ — so the advisor could hallucinate repo
state (e.g. reading edit tool calls and concluding "the branch has lots of
changes" when the working tree is clean and the branch is merely behind its
base). `advisor-context.ts` closes that gap with a deterministic
`## Repository state (verified now — authoritative over the transcript)` block
prepended to the prompt: current branch, ahead/behind vs the base branch,
working-tree status (clean, or a capped `git status --short` + change stats),
and an explicit note that "behind" counts unmerged base commits, not local
edits. It's best-effort (any git failure degrades to no block) and only emitted
inside a git work tree.

This keeps the **bare-advisor contract** (no tools, per the native tool) while
raising context quality — the opposite axis from Amp's "Oracle", which is a full
sub-agent with its own read/edit/terminal tools and context window. A future
opt-in "investigative advisor" (read-only tools, Oracle-style) is possible but
deliberately not the default: it diverges from the native drop-in parity and
costs more latency/tokens.

**Executor-controlled shaping (optional).** On top of the automatic context, the
executor can focus a consult with `question` (its specific ask, placed last so
it is the most salient instruction) and enrich it with `include_diff` (attaches
the capped, verified working-tree diff via `buildAdvisorWorkingDiff`). Both are
additive — there is no knob to _reduce_ context, on purpose (see the contract
section). This mirrors Amp's promptable Oracle while staying tool-free.

### Advisor result rendering

The advice is prose (headings, lists, code), so the `advisor` tool returns
`{ result, resultFormat: 'markdown' }` and the tool card renders it through the
Markdown pipeline instead of a raw `<pre>` (the same `resultFormat` seam ACP
tool output uses). `resultFormat` now flows generically: any tool's
`ToolExecuteResult` may carry it (`packages/agent/src/wire-types.ts` →
`run-agent-loop` tool-result chunk → `ToolCall.resultFormat` → renderer). The
advice is prefixed with a `**Advisor — <model>**` attribution line
(`attributeAdvice` / `formatAdvisorModelLabel`) so the card shows _which_ model
produced it — the advisor model's output, plainly distinct from the executor
model that drives the surrounding conversation. Covered by the component test
`src/renderer/views/tool-display.test.ts` (attributed-markdown case).

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
