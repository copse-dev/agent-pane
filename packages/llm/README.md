# @copse/llm (extraction prototype)

This directory is a **scaffold**, not yet wired into the build. It sketches the
package boundary for extracting the LLM client that currently lives in
`src/shared/llm/`, following the same path the markdown renderer took:
in-repo `packages/*` workspace → standalone repo consumed as a git dependency
(`@copse/streaming-markdown`).

The working code still lives at `src/shared/llm/` and is imported through the
`@shared/llm` barrel (`src/shared/llm/index.ts`). This `package.json` documents
the target manifest — its name, entry point, and the only two runtime
dependencies the module actually needs (`openai`, `@anthropic-ai/sdk`).

## What the module is

A provider-agnostic LLM client, ~2,180 LOC across 18 files:

- **Provider adapters** — `anthropic-provider`, `openai-provider`, `openrouter`,
  `extra-providers` (OpenAI-compatible presets + user endpoints), `mock-provider`.
- **Cross-cutting machinery** — `model-catalog`, `estimate-cost`,
  `redact-secrets` / `redacting-provider`, `stream-retry`, `parse-tool-args`,
  `provider-stop-reason`, `provider-slug`, `credential-url`, `reserved-prefixes`.

Every provider implements the `LLMProvider` interface (`types.ts`). The public
surface is the `index.ts` barrel.

## Why it's a good extraction candidate

- **Cohesive and reusable** — a generic multi-provider client, useful outside
  this app.
- **Self-contained** — after the change that landed alongside this scaffold, it
  has **zero upward imports** into app-specific code. (Previously
  `extra-providers.ts` reached up into `../remote-agent.ts` for one constant;
  that constant now lives in the module at `reserved-prefixes.ts`, and
  `remote-agent.ts` re-exports it.)
- **Clear API** — imported by ~30 files, all through `@shared/llm`.

## Wire types now travel with the module

The prerequisite that used to block a clean cutover — the module's wire types
living in the app-wide `@shared/types` barrel — is done. `src/shared/llm/wire-types.ts`
now owns `LLMMessage` (+ `UserContent`/`ToolCallContent`/`ToolResult`), `LLMTool`,
`ModelUsage`, `ThreadUsage`, `LLMProvider`, `ToolCallChunk`, and the provider
output type `ProviderStreamChunk`. `@shared/types` re-exports every one of them,
so the 100+ files importing these from `@shared/types` are unchanged (app →
package, the direction extraction needs), and the whole `src/shared/llm/`
module — source **and** tests — imports its types only from `./wire-types.ts`.

Two knots were untied to get there:

- **`StreamChunk` was fat.** The app's `StreamChunk` carried orchestration
  events providers never emit (`subagent_*`, `todo_*`, `context_*`,
  `model_comparison`, `post_turn_review`, `text_replace`) and dragged in
  `SubagentSession`, `ModelComparison`, `TodoItem`. The module now owns the
  narrow `ProviderStreamChunk` (the six variants providers actually emit —
  text/reasoning/tool_call/tool_result/usage/done); the app's `StreamChunk` is
  `ProviderStreamChunk | <orchestration events>`. Because a provider stream is a
  subset, it stays assignable to every `StreamChunk` sink. Narrowing the
  `LLMProvider` contract surfaced two app-side test mocks that leaned on the fat
  type — now corrected to the real provider contract.
- **`LLMProvider` was duplicated** verbatim in `@shared/types/provider.ts` and
  `src/shared/llm/types.ts`. Folded into one definition in `wire-types.ts`.

## Cutover checklist (mirrors PR #689 for streaming-markdown)

1. ~~Relocate the LLM wire types out of `@shared/types`.~~ Done — they live in
   `src/shared/llm/wire-types.ts` and `@shared/types` re-exports them. On the
   physical move, the `@shared/types` re-export lines flip to point at
   `@copse/llm`.
2. Move `src/shared/llm/*` → `packages/llm/src/*`.
3. Re-add `"workspaces": ["packages/*"]` to the root `package.json`; add the
   `@copse/llm` path alias to `tsconfig{,.node,.web}.json`,
   `scripts/build.mts`, and `scripts/run-tests.mts` (as `@shared` is aliased
   today); include `packages/*` in `.c8rc.json`.
4. Rewrite the ~30 `@shared/llm[...]` importers to the bare `@copse/llm`
   specifier.
5. Later, cut the in-repo workspace over to a standalone repo consumed as a git
   dependency, exactly as PR #689 did for the markdown package.
