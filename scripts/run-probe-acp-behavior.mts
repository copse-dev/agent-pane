import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// Bundle the Tier-2 ACP behavioural-probe runner (which imports app modules that
// use the `@shared` alias and `.ts` extensions) into a single CJS file, then
// run it. Mirrors run-probe-acp-agents.mts. Provider keys stay in the env —
// real agents need auth to complete a prompted turn.
const out = resolve('dist-test/probe-acp-behavior-lib.cjs')
await esbuild.build({
  entryPoints: [resolve('scripts/probe-acp-behavior-lib.mts')],
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
