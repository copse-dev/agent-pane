// Bundle and run the headless benchmark with test-only conversation scenarios.
// This launcher is used for development and CI, never a shipped bundle.
import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const out = resolve('dist-test/bench-agent-entry.cjs')
await esbuild.build({
  entryPoints: [resolve('scripts/bench-agent-entry.mts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  alias: {
    '@shared': resolve('./src/shared'),
  },
  define: { __COPSE_TEST_SCENARIOS__: 'true' },
})

const result = spawnSync('node', [out, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
})
process.exit(result.status ?? 1)
