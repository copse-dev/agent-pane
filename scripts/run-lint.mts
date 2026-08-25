import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

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
 */
const shards: readonly { label: string; args: readonly string[] }[] = [
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
      '.',
    ],
  },
]

const eslintCli = resolve('node_modules/eslint/bin/eslint.js')
const forwardedArgs = process.argv.slice(2)

for (const shard of shards) {
  console.log(`[lint] ${shard.label}`)
  const result = spawnSync(process.execPath, [eslintCli, ...forwardedArgs, ...shard.args], {
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
