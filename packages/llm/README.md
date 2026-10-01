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
- **Leaf helpers come from `@copse/std`** (`at`, `errorMessage`, `isRecord`), the
  shared home for the utilities that used to be vendored here as `internal-utils.ts`.

## Model capabilities: one lookup, not id-prefix checks

Never decide behaviour from a model id string (`model.startsWith('gpt')`). Ask
`modelCapabilities(selection)` (`model-capabilities.ts`); a test
(`scripts/model-id-routing.test.ts`, part of `pnpm test`) fails when a literal
`startsWith('gpt…')`, `includes('claude…')` or `/^gpt…/` appears in shipped source
outside the capability modules. For just the provider, use
`firstPartyProviderOf(selection)`.

It takes the **stored selection** (`claude-opus-5`, `openrouter:openai/gpt-5`,
`lmstudio:…`), not a bare id, and returns a readonly record:

| Field                                                                                                      | Meaning                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `transport`                                                                                                | `anthropic`, `openai-responses`, `openai-chat`, `openai-compatible` (OpenRouter / extra providers), `local` (LM Studio), `host-routed` (`acp:`, `remote-agent:`, `plugin-model:`, `auto:`), or `unknown` (an unprefixed id nothing claims) |
| `provider`                                                                                                 | `anthropic` / `openai` for a direct first-party route, else `null`                                                                                                                                                                         |
| `family`, `known`                                                                                          | canonical family key (`gpt-5`, `claude-opus-5`) and whether a table entry matched                                                                                                                                                          |
| `supportsStrictTools`, `supportsVerbosity`, `supportsParallelToolCallsControl`, `supportsServerCompaction` | **API flags**: may the request to _this route_ carry the field. Only ever true on a direct first-party route                                                                                                                               |
| `prefersApplyPatch`, `acceptsDeveloperRole`, `acceptsMidConversationSystem`                                | **lineage flags**: how the _model_ behaves wherever it is served, so they follow the vendor-stripped id through OpenRouter and extra providers                                                                                             |
| `parameters`                                                                                               | `modelParameterSupport(selection)` — reasoning levels and sampling knobs. Still the source of truth; not a second table                                                                                                                    |
| `contextWindow`                                                                                            | from the generated catalog, including dated snapshots of a catalogued model; `null` when unknown                                                                                                                                           |

**Where the data lives.** `model-families.ts` is a leaf module (so `model-catalog.ts` and
`model-parameters.ts` can use it without an import cycle) holding the `FAMILIES`
table and the resolver. An entry matches on an id _boundary_ — the id itself or
the entry followed by `-`, `.`, `:` or `@` — so `gpt-5.6-sol-2026-07-01`, `gpt-5-mini` and
`claude-opus-5:beta` resolve to their family while `gpt-50` and `o1x-turbo` do not;
the longest entry wins, which is how `gpt-oss` opts out of `gpt-5`-era features.

**Unknown models are conservative.** An id matching no entry gets `known: false`
and every optional flag off. A bare `gpt-…`/`claude-…` id still reaches its
provider (the user's key for it is the only place it can go) but on that provider's
conservative transport (`gpt-7-x` → chat completions, nothing optional). Never widen
a flag because an id "looks like" a family.

**Adding a model or capability.** A new model in an existing family needs nothing.
A new family is one `FAMILIES` entry plus a row in `model-capabilities.test.ts`. A new
capability is a field on `ModelFeatures`, a value per family, and the code that reads
it — flip it to `true` only for families you verified; a missing capability costs a
feature, a wrong one is a 400. `supportsServerCompaction` is off everywhere until the
thread that consumes it verifies families.

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
