import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const outfile = resolve('dist-test/smoke-apple-desktop.cjs')
await esbuild.build({
  entryPoints: ['scripts/apple-desktop-guest.mts'],
  outfile: resolve('dist-test/apple-desktop-current-guest.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  logLevel: 'warning',
})
await esbuild.build({
  entryPoints: ['scripts/smoke-apple-desktop.mts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  logLevel: 'warning',
})
const result = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], {
  stdio: 'inherit',
})
process.exitCode = result.status ?? 1
