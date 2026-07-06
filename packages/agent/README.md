# @copse/agent

A provider-agnostic agent loop, extracted from `src/shared/agent/` into an
in-repo workspace package — the same staging step `@copse/llm` took (PR #715)
and the markdown renderer took before becoming the standalone
`@copse/streaming-markdown` git dependency (PR #689).

The module's source lives here (`packages/agent/src/`). App code imports it via
the `@copse/agent/*` specifier, resolved by a tsconfig path alias + esbuild
alias (the same mechanism `@shared` and `@copse/llm` use), so no `npm install` /
workspace symlink is required in-repo. Runtime dependencies: `@copse/llm`
(provider contract + stop-reason machinery) and `zod` (ask-user option
schemas). The package imports **nothing** from the host app.

## What's in it

~2,700 LOC:

- **The loop** — `run-agent-loop` (streaming tool-call orchestration, finalize
  nudges, duplicate-call guards, context-pressure signals, todo gating),
  `run-subagent` (explore / CI-investigator sessions), `agent-host` (the
  transport seam that keeps the loop Electron-free).
- **Loop machinery** — `agent-loop-guards`, `agent-loop-escalation`,
  `agent-loop-limits` (deadlines/budgets), `trim-history` (in-loop compaction).
- **Run input/output plumbing** — `parse-agent-run-payload`,
  `parse-text-tool-calls` (Cursor-style XML tool-call recovery),
  `agent-text-chunk`, `build-text-with-attachments`.
- **Tool-adjacent helpers** — `read-file-limits`, `read-file-page`,
  `search-routing`, `ask-user-format`, `review-subagent`.
- **Context accounting** — `context-breakdown`, `working-brief`.
- **Wire types** (`wire-types.ts`) — the loop contract and the values that
  cross it: `AgentStreamChunk` (what the loop emits), `AgentRunPayload` (the
  run input), `SubagentSession`/`SubagentMessage`/`ToolCall`, the
  `ToolExecuteResult` contract, `TodoItem` and friends, and the
  `ContextBreakdown` shapes. `@shared/types` re-exports every one of these, so
  app files importing them from `@shared/types` are unchanged.
- **`internal-utils.ts`** — vendored copies of the app's `at` / `errorMessage`
  helpers, so the package pulls nothing from `@shared/*`.

## Imports: granular subpaths, not the barrel

`index.ts` is the full public API (`exports["."]`, bare `@copse/agent`), but app
code deep-imports granular subpaths (`@copse/agent/run-agent-loop`,
`@copse/agent/read-file-limits`, …) — **deliberately**. The renderer imports
only the pure helper modules (context breakdown, read-file paging, ask-user
formatting); the loop itself is main-process-only.

## Design decisions made during extraction

- **`StreamChunk` was still fat for the loop.** After PR #715 the app's
  `StreamChunk` was `ProviderStreamChunk | <orchestration events>`, but the
  loop only ever emits a subset of those events. The package now owns
  `AgentStreamChunk` — the provider contract plus what the _loop_ injects
  (`text_replace`, `context_pressure`, `subagent_*`) — and the app's
  `StreamChunk` is `AgentStreamChunk | <app-level events>` (`context_trimmed`,
  `todo_*`, `post_turn_review`, `model_comparison`), which the app emits around
  the loop. A loop stream is a subset, so it stays assignable to every
  `StreamChunk` sink.
- **`AgentHost` became generic.** The host seam carries app-level chunks too
  (the app pushes `todo_update` through the same sink), so it is
  `AgentHost<TChunk = AgentStreamChunk>`; the app instantiates
  `AgentHost<StreamChunk>`.
- **The todo finalize gate moved in.** `hasOpenTodos` and
  `OPEN_TODOS_FINALIZE_NUDGE` had exactly one consumer — the loop — so they
  moved from `@shared/todos/todo-logic.ts` into `agent-loop-guards.ts`
  alongside the sibling nudge constants.
- **The explore-tool lists are two distinct constants** — `run-subagent`'s
  `EXPLORE_TOOL_NAMES` (the subagent tool allowlist, the one app code imports)
  and `agent-loop-guards`' `DUPLICATE_EXPLORE_TOOLS` (the duplicate-call
  detection set). Their membership differs deliberately: the detection set
  omits `semantic_search`.

## Remaining step for a true standalone repo

Same as `@copse/llm`: lift `packages/agent/` into its own repository and consume
it as a git/npm dependency, flipping the `@copse/agent/*` tsconfig-path +
esbuild aliases to a real `node_modules` resolution. The boundary, the
self-containment, the type ownership, and the bundling story are done and
enforced by the build.

The `@shared/types` re-export shims are the permanent facade for app code: app
files keep importing the wire types from `@shared/types`, and the shims are the
single place that repoints to the git/npm dependency when the lift happens. App
imports are not planned to move to `@copse/agent` directly.
