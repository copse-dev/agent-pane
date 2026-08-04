// Bundle + run the doctrine eval so native TypeScript, workspace aliases, and
// the test-only mock directives behave consistently with the other headless
// benchmark launchers.
import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const output = resolve('dist-test/doctrine-eval-lib.cjs')
await esbuild.build({
  entryPoints: [resolve('scripts/doctrine-eval-lib.mts')],
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
  define: { __COPSE_TEST_DIRECTIVES__: 'true' },
})

const result = spawnSync('node', [output, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
})
process.exit(result.status ?? 1)
