// Bundle + run the headless bench harness (same launcher pattern as
// run-validate-local-agent.mts). `__COPSE_TEST_DIRECTIVES__` is defined true so
// mock-provider `[[mcp:…]]` directives work for the deterministic smoke tasks —
// this is a dev/CI harness, never a shipped bundle.
import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const out = resolve('dist-test/bench-agent-lib.cjs')
await esbuild.build({
  entryPoints: [resolve('scripts/bench-agent-lib.mts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  alias: {
    '@shared': resolve('./src/shared'),
    '@copse/agent': resolve('./packages/agent/src'),
    '@copse/llm': resolve('./packages/llm/src'),
  },
  define: { __COPSE_TEST_DIRECTIVES__: 'true' },
})

const result = spawnSync('node', [out, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
})
process.exit(result.status ?? 1)
