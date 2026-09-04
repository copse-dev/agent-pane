# @copse/hooks-dialects

The three agent hook dialects Copse speaks — Cursor's `hooks.json`, Claude Code's
settings hooks, and Copse's own `hooks.json` — normalised onto the canonical event
vocabulary in `@copse/agent/hooks`, plus the sandboxed hook process spawn and the
command-hook runner that drives them. Extracted from `src/main/services/hooks/`
and `src/shared/` into an in-repo workspace package — the same staging step
`@copse/llm`, `@copse/agent`, `@copse/plan-usage`, `@copse/std`, `@copse/shell-guard`,
and `@copse/thread-store` took. About 6,000 LOC plus tests. Runtime dependencies:
`@copse/agent` (canonical events, executor contract, outcome vocabulary),
`@copse/std`, `micromatch`, `zod`. No host-app imports.

The design source of truth is `docs/plans/hooks-and-feature-packs.md` (decision 25
records this package; execution-guidance rule 4 names the layout). The landed
architecture is `docs/hooks.md`; per-dialect support and trust models are
`docs/cursor-hooks.md`, `docs/claude-hooks.md`, `docs/copse-hooks.md`.

## What's in it

- **Dialect adapters** — `cursor-adapter.ts`, `claude-adapter.ts`, `copse-adapter.ts`:
  discovery of each vendor's config files, matcher semantics, marshalling a
  canonical event into the vendor's wire payload, and interpreting the response
  (including each dialect's failure semantics — Cursor's tri-state `failClosed`,
  Claude's exit-code contract). `dialect-adapter.ts` is the contract they
  implement; `dialect-registry.ts` maps a `HookDialect` to its adapter.
- **Runner and spawn** — `command-hook-runner.ts` spawns, interprets, applies the
  blocked-by-sandbox escalation, and reports each execution to a `record` sink;
  `hook-spawn.ts` is the process spawn (stdin payload, stdout/stderr capture,
  timeout, output cap) with the sandbox runtime seam; `hook-depth.ts` is the
  recursion guard; `session-env.ts` the per-session env store (H4);
  `sandbox-failure-detection.ts` the runner-signal-only sandbox failure detector.
- **Types and schemas** — `hooks-types.ts`, `cursor-hooks.ts`, `claude-hooks.ts`,
  the vendored vendor schemas (`vendored-hook-schemas.ts`, drift-checked by
  `vendor-schema-drift.test.ts`), and `hook-run-detail.ts`.

## The host environment seam

`environment.ts` holds the four facts the package cannot know, installed once with
`configureHooksDialects`; every default is the conservative reading:

- `sandbox` — the OS sandbox hooks spawn inside by default (F3, decision 7).
  Default: none, so hooks spawn unsandboxed exactly as on Linux and Windows.
- `childEnv` — the environment handed to an unsandboxed hook. Default: the
  process env minus undefined values; the app binds its secret scrubber.
- `agentExecutionRoot` — the current turn's execution root. Default: unknown.
- `dataRoot` — where the user-level `hooks.json` lives. Default: `COPSE_DIR` or
  `~/.copse`.

The runner takes no recording state. `createCommandHookRunner({ record })` reports
each run to the sink it is given; the app's `src/main/services/hooks/command-hook-runner.ts`
wrapper keeps the original `recordingSnapshot` API by binding that sink to the
spine recorder, so fire sites and their tests are unchanged.

## Imports

App code keeps importing from `src/main/services/hooks/*` and `@shared/hooks/*`,
`@shared/types/hooks.ts`, `@shared/types/cursor-hooks.ts`,
`@shared/types/claude-hooks.ts`; those files are re-exports of this package and
import `hooks-dialects-environment.ts` for its side effect. `detectSandboxFailure`
is re-exported from `src/main/services/security/sandbox-failure.ts`, whose prompt
formatters stay in the app.

## Tests

Adapter-level tests travel with the package: `hook-spawn`, `hook-depth`,
`command-hook-runner`, `cursor-matcher`, `hook-timeout-defaults`,
`vendor-schema-drift`, `hook-run-detail`. The integration tests that drive an
adapter through an app fire site (`cursor-adapter.test.ts`,
`claude-adapter.test.ts`, `copse-adapter.test.ts`, `failClosed-both-modes`,
`hook-sandbox-block`, `permission-hook-io`, and the byte-exact
`payload-snapshots` against `__snapshots__/wire-payloads.json`) stay in the app.

## Standalone path

The dependency is resolved through the manifest, so a future move to its own
repository changes the dependency source, not app imports or build configuration.
