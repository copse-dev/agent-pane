import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { isDirectExecution } from './lib/direct-execution.mts'

/**
 * Type-aware ESLint retains each TypeScript program for the lifetime of one
 * invocation. Linting the whole repository at once therefore holds both the
 * node and renderer programs, plus every file's rule state, in one V8 heap.
 * Run bounded, sequential shards instead: each child exits and releases its
 * program before the next project is loaded.
 *
 * The final catch-all preserves `eslint .` coverage for standalone JS and any
 * future top-level source. Its ignore patterns exclude only files owned by an
 * earlier shard; repository-configured ignores still apply normally.
 *
 * `--shard=<index>` lints one shard only. `scripts/check-local.mts` runs the
 * shards that way, side by side, on a host with the memory for it.
 */
export const LINT_SHARDS: readonly { label: string; args: readonly string[] }[] = [
  { label: 'main services', args: ['src/main/services'] },
  {
    label: 'remaining node project',
    args: [
      '--ignore-pattern',
      'src/main/services/**',
      'src/main',
      'src/preload',
      'src/shared',
      'scripts',
      'packages',
    ],
  },
  { label: 'renderer project', args: ['src/renderer', 'tests/setup-dom.ts'] },
  {
    label: 'e2e project',
    args: ['tests/e2e', 'wdio.conf.ts', 'wdio.ci.conf.ts', 'wdio.eval.conf.ts'],
  },
  { label: 'demo project', args: ['tests/demo', 'wdio.demo.conf.ts'] },
  {
    label: 'standalone files',
    args: [
      '--ignore-pattern',
      'src/**',
      '--ignore-pattern',
      'packages/**',
      '--ignore-pattern',
      'scripts/**',
      '--ignore-pattern',
      'tests/setup-dom.ts',
      '--ignore-pattern',
      'tests/e2e/**',
      '--ignore-pattern',
      'tests/demo/**',
      '--ignore-pattern',
      'wdio*.conf.ts',
      '.',
    ],
  },
]

function selectedShards(argv: readonly string[]): typeof LINT_SHARDS {
  const flag = argv.find((arg) => arg.startsWith('--shard='))
  if (flag === undefined) return LINT_SHARDS
  const shard = LINT_SHARDS[Number(flag.slice('--shard='.length))]
  if (shard === undefined || !/^--shard=\d+$/.test(flag)) {
    console.error(`[lint] ${flag}: expected an index below ${String(LINT_SHARDS.length)}`)
    process.exit(2)
  }
  return [shard]
}

function main(): void {
  const eslintCli = resolve('node_modules/eslint/bin/eslint.js')
  const argv = process.argv.slice(2)
  const forwardedArgs = argv.filter((arg) => !arg.startsWith('--shard='))
  for (const shard of selectedShards(argv)) {
    console.log(`[lint] ${shard.label}`)
    const result = spawnSync(process.execPath, [eslintCli, ...forwardedArgs, ...shard.args], {
      stdio: 'inherit',
    })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}

if (isDirectExecution(import.meta.url, 'run-lint')) main()
