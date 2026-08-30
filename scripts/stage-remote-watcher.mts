import { execFileSync } from 'node:child_process'
import { accessSync, cpSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Dev helper: build `copse-remote-watcher` for the current host with a local
 * cargo toolchain and stage it into `vendor/remote-watcher/<target>/`, where
 * `scripts/build.mts` (and the runtime vendor fallback in
 * bundled-remote-watcher.ts) pick it up.
 *
 * Release packaging does not use this — the CI lane
 * (.github/workflows/remote-watcher-build.yml) cross-compiles all four
 * targets; this exists so a dev on an ARM Mac can exercise an SSH workspace
 * whose remote is also an ARM Mac (or run against localhost) without CI.
 */

const CRATE = resolve('native/remote-watcher')

const hostTarget = ((): string => {
  const line = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
    .split('\n')
    .find((l) => l.startsWith('host: '))
  if (!line) throw new Error('could not determine rustc host target')
  return line.slice('host: '.length).trim()
})()

console.log(`[stage-remote-watcher] building for ${hostTarget}`)
execFileSync('cargo', ['build', '--release'], { cwd: CRATE, stdio: 'inherit' })

const built = join(CRATE, 'target/release/copse-remote-watcher')
accessSync(built)
const outDir = resolve('vendor/remote-watcher', hostTarget)
mkdirSync(outDir, { recursive: true })
cpSync(built, join(outDir, 'copse-remote-watcher'))
console.log(`[stage-remote-watcher] staged ${join(outDir, 'copse-remote-watcher')}`)
