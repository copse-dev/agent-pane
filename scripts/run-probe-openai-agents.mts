import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const out = resolve('.tmp/openai-agents-probe.mjs')
await esbuild.build({
  entryPoints: [resolve('scripts/probe-openai-agents.mts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
})
const result = spawnSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exitCode = result.status ?? 1
