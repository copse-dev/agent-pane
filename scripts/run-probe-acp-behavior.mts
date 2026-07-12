import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// Bundle the Tier-2 ACP behavior-eval runner (imports app modules using the
// `@shared` alias / `.ts` extensions) into a single CJS file, then run it.
// Mirrors run-probe-acp-agents.mts. Provider keys are left in the env: this runs
// real model turns, and the agent brings its own credentials.
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
