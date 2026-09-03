# @copse/llm

A provider-agnostic LLM client, extracted from `src/shared/llm/` into an in-repo
workspace package — the same staging step the markdown renderer took before it
became the standalone `@copse/streaming-markdown` git dependency (PR #689).

The module's source now lives here (`packages/llm/src/`). pnpm links it as a real
workspace dependency, and app/build/test code resolves its declared `exports`
through `node_modules` without tsconfig or esbuild aliases. Runtime dependencies:
`openai`, `@anthropic-ai/sdk`, `@lmstudio/sdk`, and `zod`. The package imports
**nothing** from the host app.

## What's in it

~2,180 LOC:

- **Provider adapters** — `anthropic-provider`, `openai-provider`, `openrouter`,
  `extra-providers` (OpenAI-compatible presets + user endpoints), `mock-provider`.
- **Cross-cutting machinery** — `model-catalog`, `estimate-cost`,
  `redact-secrets` / `redacting-provider`, `stream-retry`, `parse-tool-args`,
  `provider-stop-reason`, `provider-slug`, `credential-url`, `reserved-prefixes`.
- **Wire types** (`wire-types.ts`) — the provider contract and the values that
  cross it: `LLMMessage` (+ `UserContent`/`ToolCallContent`/`ToolResult`),
  `LLMTool`, `ModelUsage`, `ThreadUsage`, `LLMProvider`, `ToolCallChunk`, and the
  provider output type `ProviderStreamChunk`. `@shared/types` re-exports every one
  of these, so the 100+ app files importing them from `@shared/types` are
  unchanged.
- **`internal-utils.ts`** — vendored copies of the app's `at` / `errorMessage`
  helpers, so the package pulls nothing from `@shared/*`.

## Imports: granular subpaths, not the barrel

`index.ts` is the full public API (`exports["."]`, bare `@copse/llm`), but app
code deep-imports granular subpaths (`@copse/llm/model-catalog`,
`@copse/llm/extra-providers`, …) — **deliberately**. The renderer imports only the
pure, browser-safe modules (model catalog, extra-providers, provider-slug, …); a
flat barrel would drag the node-only provider SDKs (`openai`,
`@anthropic-ai/sdk`) into its bundle. Verified: a browser bundle of the
renderer-side subpaths pulls in **zero** SDK modules.

## Design decisions made during extraction

- **`StreamChunk` was fat.** The app's `StreamChunk` carried orchestration events
  providers never emit (`subagent_*`, `todo_*`, `context_*`, `model_comparison`,
  `post_turn_review`, `text_replace`) and dragged in `SubagentSession`,
  `ModelComparison`, `TodoItem`. The package owns the narrow `ProviderStreamChunk`
  (the six variants providers actually emit — text/reasoning/tool_call/tool_result/
  usage/done); the app's `StreamChunk` is `ProviderStreamChunk | <orchestration
events>`. Because a provider stream is a subset, it stays assignable to every
  `StreamChunk` sink. Narrowing the `LLMProvider` contract surfaced two app-side
  test mocks that leaned on the fat type — corrected to the real contract.
- **`LLMProvider` was duplicated** verbatim in `@shared/types/provider.ts` and the
  module's `types.ts`. Folded into one definition in `wire-types.ts`.
- **The one upward import was severed.** `extra-providers.ts` used to reach into
  `../remote-agent.ts` for `REMOTE_AGENT_MODEL_PREFIX`; that model-id constant now
  lives in `reserved-prefixes.ts` and `remote-agent.ts` re-exports it.

## Standalone path

The workspace dependency is already resolved through the package manifest. A
future split into its own repository therefore changes the dependency source,
not app imports or build configuration. The `@shared/types` re-exports already
point at `@copse/llm` and need no change.
