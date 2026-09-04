# @copse/std

Dependency-free leaf utilities that both the app and every extracted workspace
package need. About 200 lines, no runtime dependencies, no host-app imports.

## Why a package

The workspace invariants (`scripts/workspace-package-invariants.test.ts`) forbid a
package importing from the host app. Before this package existed, `@copse/agent`,
`@copse/llm`, and `@copse/plan-usage` each carried a vendored `internal-utils.ts`
with byte-identical copies of `at`, `errorMessage`, and `isRecord` so they could
stay host-free. Every further extraction would have added another copy. This
package is the one home, and the copies are gone.

## What's in it

- **`unknown-value.ts`** — narrowing helpers for values that arrive as `unknown`
  (`isRecord`, `expectString`, `optionalRecord`, `nonEmptyStringOr`, …). The
  app's most-imported module: over a hundred source files and thirty scripts.
- **`safe-json.ts`** — `safeJsonParse` (returns `null` instead of throwing, takes a
  `JsonDecoder` for a typed result), `decodeWithSchema` (adapts any
  `safeParse`-shaped schema), and `safeJsonStringify` with its honest
  `string | undefined` return type. See `docs/type-safety.md`.
- **`array-utils.ts`** — `at`, checked element access under
  `noUncheckedIndexedAccess`.
- **`errors.ts`** — `errorMessage`, safe message extraction from a caught
  `unknown`.

## Imports

App code keeps importing from the `@shared/*` paths (`@shared/unknown-value.ts`,
`@shared/safe-json.ts`, `@shared/array-utils.ts`, `@shared/errors.ts`); those
files are now one-line re-exports of this package. Scripts that run under plain
Node keep importing `src/shared/unknown-value.mts` for the same reason. New code
in packages imports the granular subpaths directly
(`@copse/std/unknown-value.ts`).

## Standalone path

Same as the other workspace packages: the dependency is already resolved through
the manifest, so moving to a separate repository changes the dependency source,
not app imports or build configuration.
