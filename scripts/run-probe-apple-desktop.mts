import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

// Main-process engine helpers use the same aliases as the other container CLIs.
mkdirSync('dist-test', { recursive: true })
const outfile = resolve('dist-test/probe-apple-desktop.cjs')
await build({
  entryPoints: ['scripts/probe-apple-desktop.mts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'warning',
  alias: { '@shared': resolve('src/shared') },
})
const result = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], {
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
