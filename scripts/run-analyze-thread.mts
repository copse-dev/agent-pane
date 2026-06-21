import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const out = resolve('dist-test/analyze-thread-jsonl.cjs')
await esbuild.build({
  entryPoints: [resolve('scripts/analyze-thread-jsonl.mts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  alias: { '@shared': resolve('./src/shared') },
})

const result = spawnSync('node', [out, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
})
process.exit(result.status ?? 1)
