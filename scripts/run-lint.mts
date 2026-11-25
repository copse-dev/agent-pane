import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { LINT_SHARDS, shardEslintArgs } from './lib/lint-shards.mts'

/**
 * `eslint .`, run as the bounded, sequential shards in `lib/lint-shards.mts`
 * so that no single invocation holds every typed program at once. Together the
 * shards lint exactly the files `eslint .` would (`lib/lint-shards.test.ts`).
 */
const root = resolve('.')
const eslintCli = resolve('node_modules/eslint/bin/eslint.js')
const forwardedArgs = process.argv.slice(2)

for (const shard of LINT_SHARDS) {
  console.log(`[lint] ${shard.label}`)
  const args = [eslintCli, ...forwardedArgs, ...shardEslintArgs(shard, root)]
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
