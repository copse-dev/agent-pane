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

## The one remaining prerequisite before a real cutover

The module's wire types still live in the app-wide `@shared/types` barrel:
`LLMMessage`, `LLMTool`, `StreamChunk`, `ThreadUsage`, `ModelUsage`. They must
travel **with** the package (as `@copse/streaming-markdown` owned its own types)
rather than stay in `@shared/types`, which is imported by 100+ files. Options:

1. Move those five types into this package and have the app import them from
   `@copse/llm`; or
2. Publish a thin `@copse/llm-types` (or shared `@copse/types`) that both depend
   on.

## Cutover checklist (mirrors PR #689 for streaming-markdown)

1. Relocate the LLM wire types out of `@shared/types` (see above).
2. Move `src/shared/llm/*` → `packages/llm/src/*`.
3. Re-add `"workspaces": ["packages/*"]` to the root `package.json`; add the
   `@copse/llm` path alias to `tsconfig{,.node,.web}.json`,
   `scripts/build.mts`, and `scripts/run-tests.mts` (as `@shared` is aliased
   today); include `packages/*` in `.c8rc.json`.
4. Rewrite the ~30 `@shared/llm[...]` importers to the bare `@copse/llm`
   specifier.
5. Later, cut the in-repo workspace over to a standalone repo consumed as a git
   dependency, exactly as PR #689 did for the markdown package.
