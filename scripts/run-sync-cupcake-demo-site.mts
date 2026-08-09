import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const out = resolve('dist-test/sync-cupcake-demo-site.cjs')
await esbuild.build({
  entryPoints: [resolve('scripts/sync-cupcake-demo-site.mts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  alias: {
    '@shared': resolve('./src/shared'),
    '@copse/agent': resolve('./packages/agent/src'),
    '@copse/llm': resolve('./packages/llm/src'),
  },
})

const result = spawnSync('node', [out, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
})
process.exit(result.status ?? 1)
