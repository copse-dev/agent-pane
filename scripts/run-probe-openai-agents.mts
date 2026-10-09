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
if (
  process.argv.includes('--setup-repository') ||
  process.argv.some((arg) => arg.startsWith('--setup-repository='))
) {
  for (const [entry, name] of [
    ['src/main/services/remote/openai-git-worker-entry.ts', 'openai-probe-git-worker.cjs'],
    ['scripts/openai-setup-diagnostic-worker.mts', 'openai-probe-diagnostic-worker.cjs'],
  ]) {
    if (!entry || !name) throw new Error('Missing diagnostic build entry')
    await esbuild.build({
      entryPoints: [resolve(entry)],
      outfile: resolve('.tmp', name),
      bundle: true,
      platform: 'node',
      format: 'cjs',
    })
  }
}
const result = spawnSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exitCode = result.status ?? 1
