// Bundle + run the terminal-screen eval so native TypeScript and the workspace
// aliases behave consistently with the other headless benchmark launchers.
import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const output = resolve('dist-test/terminal-screen-eval-lib.cjs')
await esbuild.build({
  entryPoints: [resolve('scripts/terminal-screen-eval-lib.mts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  alias: {
    '@shared': resolve('./src/shared'),
    '@copse/agent': resolve('./packages/agent/src'),
    '@copse/llm': resolve('./packages/llm/src'),
    '@copse/plan-usage': resolve('./packages/plan-usage/src'),
  },
})

const result = spawnSync('node', [output, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
})
process.exit(result.status ?? 1)
