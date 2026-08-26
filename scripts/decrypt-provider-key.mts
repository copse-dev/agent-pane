/**
 * Decrypt a stored provider API key out of a Copse profile, for tooling that
 * needs to hand the key to a process that cannot read it itself.
 *
 * Why this exists: `pnpm perf:compare --eval` runs one workload on the Electron
 * stack and the same workload on the Tauri+Servo sidecar, and the sidecar
 * installs no secret cipher at all — `src/sidecar/electron-shim` stubs
 * `safeStorage` out and nothing puts the keyring cipher in its place, so
 * `getApiKey` returns null there. Decrypting once here and handing the value to
 * both stacks in the environment is what makes the two columns comparable:
 * `resolveApiKey`'s `<PROVIDER>_API_KEY` fallback picks it up identically on
 * both sides.
 *
 *   node scripts/decrypt-provider-key.mts <provider> <settings.json>
 *
 * Keys are sealed by one of two formats, and the stored blob says which:
 * AES-GCM under an OS-keyring data key since #1898, or Electron `safeStorage`
 * before it. A profile keeps legacy blobs only until the current build opens
 * it — reads migrate lazily and the first rewrite sweeps the rest
 * (`settings.ts`, `secret-migration.ts`) — so a helper that understands only
 * one format breaks on every profile holding the other, and breaks in a way
 * that reads as a Keychain problem rather than a format change: `safeStorage`
 * rejects a keyring blob with "Ciphertext does not appear to be encrypted",
 * which the earlier version of this script reported as a wrong Keychain
 * identity. This one opens both, through the app's own cipher rather than a
 * second implementation of either format.
 *
 * That cipher is TypeScript under `src/main/`, which plain Node cannot load —
 * the package is `type: commonjs`, so a `.ts` file is CommonJS and its ESM
 * syntax does not parse — and half of it needs Electron anyway. So the work
 * lives in `decrypt-provider-key-entry.ts`, bundled here the way `build.mts`
 * bundles the standalone main-process entry points and run under Electron.
 * This file is the launcher: arguments, the terminal guard, the build, and
 * relaying the child's stdout.
 *
 * Writes the key to stdout and nothing else. Refuses to run when stdout is a
 * terminal, so a stray invocation cannot print a secret into a scrollback
 * buffer or a captured session log.
 *
 * Exit codes: 2 usage, 3 Electron unavailable, 4 unreadable profile, 5 no such
 * stored key, 6 decrypt failed.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as esbuild from 'esbuild'
import { MAIN_EXTERNALS } from './main-externals.mts'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON_BIN = resolve(ROOT, 'node_modules/.bin/electron')
const ENTRY = resolve(ROOT, 'scripts/decrypt-provider-key-entry.ts')

function fail(message: string, code: number): never {
  console.error(`[decrypt-provider-key] ${message}`)
  process.exit(code)
}

/**
 * Build the entry and run it under Electron. Returns rather than exits so the
 * temp directory is always cleaned up — `process.exit` skips `finally`.
 */
function runEntry(provider: string, settingsPath: string): { status: number; stdout: string } {
  // Inside the repo, not the system temp dir: the externals below stay
  // `require`d at run time, and `@napi-rs/keyring` is a native binding that
  // only resolves from a path that walks up to this checkout's node_modules.
  mkdirSync(join(ROOT, '.tmp'), { recursive: true })
  const workDir = mkdtempSync(join(ROOT, '.tmp', 'decrypt-provider-key-'))
  try {
    const bundle = join(workDir, 'decrypt-provider-key.js')
    esbuild.buildSync({
      entryPoints: [ENTRY],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundle,
      // The same list the main-process bundles use: `electron` and the native
      // keyring binding are resolved from node_modules at run time, not bundled.
      external: [...MAIN_EXTERNALS],
    })
    // stdio is piped, so the key never reaches a terminal or a log. The child's
    // stderr is inherited: its diagnostics are the ones worth reading.
    const run = spawnSync(ELECTRON_BIN, [bundle, provider, settingsPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    if (run.error) {
      console.error(`[decrypt-provider-key] could not run ${ELECTRON_BIN}: ${run.error.message}`)
      return { status: 3, stdout: '' }
    }
    return { status: run.status ?? 1, stdout: run.stdout }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

const provider = process.argv[2] ?? 'openrouter'
const settingsPath = process.argv[3]

if (process.stdout.isTTY) {
  fail('refusing to write a secret to a terminal — redirect stdout', 2)
}
if (typeof settingsPath !== 'string') {
  fail('usage: node scripts/decrypt-provider-key.mts <provider> <settings.json>', 2)
}
if (!existsSync(ELECTRON_BIN)) {
  fail(`${ELECTRON_BIN} is missing — run pnpm install`, 3)
}

const { status, stdout } = runEntry(provider, settingsPath)
if (status !== 0) process.exit(status)
process.stdout.write(stdout)
