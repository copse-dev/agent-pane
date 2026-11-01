import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// The product transport resolves its controller beside its own bundle.
const outfile = resolve('dist/main/smoke-isolated-desktop.cjs')
await esbuild.build({
  entryPoints: ['scripts/smoke-isolated-desktop.mts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  logLevel: 'warning',
})
await esbuild.build({
  entryPoints: ['scripts/smoke-isolated-desktop-guest.mts'],
  outfile: resolve('dist/main/smoke-isolated-desktop-guest.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  logLevel: 'warning',
})
const recover = process.argv.includes('--recover-orphan')
const recoveryFile = resolve('dist/main/smoke-isolated-desktop-recovery.cjs')
if (recover)
  await esbuild.build({
    entryPoints: ['scripts/smoke-isolated-desktop-recovery.mts'],
    outfile: recoveryFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    logLevel: 'warning',
  })
const result = spawnSync(
  process.execPath,
  [recover ? recoveryFile : outfile, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
  },
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
