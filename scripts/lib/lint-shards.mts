import { statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * One sequential ESLint invocation of `pnpm run lint` (scripts/run-lint.mts).
 *
 * Paths are repo-relative directories or files, never globs, so that the
 * catch-all below can ignore exactly what a named shard owns.
 */
export interface LintShard {
  readonly label: string
  /** What this shard lints. */
  readonly paths: readonly string[]
  /** Paths under `paths` that a different named shard lints instead. */
  readonly except?: readonly string[]
}

/**
 * Type-aware ESLint retains each TypeScript program for the lifetime of one
 * invocation. Linting the whole repository at once therefore holds both the
 * node and renderer programs, plus every file's rule state, in one V8 heap.
 * Each named shard groups the files of one typed project, so each child exits
 * and releases its program before the next project is loaded.
 *
 * `src/sidecar` is split along its tsconfig boundary: `tsconfig.node.json`
 * excludes `ws-bridge`, which is browser-side and lives in `tsconfig.web.json`.
 */
const NAMED_SHARDS: readonly LintShard[] = [
  { label: 'main services', paths: ['src/main/services'] },
  {
    label: 'remaining node project',
    paths: ['src/main', 'src/preload', 'src/shared', 'src/sidecar', 'scripts', 'packages'],
    except: ['src/main/services', 'src/sidecar/ws-bridge'],
  },
  {
    label: 'renderer project',
    paths: ['src/renderer', 'src/sidecar/ws-bridge', 'tests/setup-dom.ts'],
  },
  {
    label: 'e2e project',
    paths: [
      'tests/e2e',
      'wdio.conf.ts',
      'wdio.ci.conf.ts',
      'wdio.eval.conf.ts',
      'wdio.quarantine.conf.ts',
    ],
  },
  { label: 'demo project', paths: ['tests/demo', 'wdio.demo.conf.ts'] },
]

/**
 * Everything no named shard owns: `eslint .` minus the named shards' paths.
 * It is derived rather than written out, so a new top-level directory lands
 * here and is linted instead of falling between shards. Repository-configured
 * ignores still apply normally.
 */
const CATCH_ALL: LintShard = {
  label: 'standalone files',
  paths: ['.'],
  except: NAMED_SHARDS.flatMap((shard) => shard.paths),
}

export const LINT_SHARDS: readonly LintShard[] = [...NAMED_SHARDS, CATCH_ALL]

/**
 * The `--ignore-pattern` value that excludes `path` and everything under it.
 * A directory needs `/**` to match its files; a bare file matches itself.
 */
function ignorePatternFor(root: string, path: string): string {
  return statSync(join(root, path)).isDirectory() ? `${path}/**` : path
}

/** The `--ignore-pattern` values that keep `shard` off paths another shard owns. */
export function shardIgnorePatterns(shard: LintShard, root: string): string[] {
  return (shard.except ?? []).map((path) => ignorePatternFor(root, path))
}

/** The ESLint CLI arguments that lint exactly `shard`. */
export function shardEslintArgs(shard: LintShard, root: string): string[] {
  return [
    ...shardIgnorePatterns(shard, root).flatMap((pattern) => ['--ignore-pattern', pattern]),
    ...shard.paths,
  ]
}
