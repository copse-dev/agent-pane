/**
 * Run Copse under the Tauri + Servo shell.
 *
 * `pnpm build:servo` first — this launches what that emitted. The shell is a
 * prebuilt binary (see tauri-shell.mts); nothing here compiles Rust.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ensureTauriShell } from './tauri-shell.mts'

const RENDERER = 'dist/renderer'
const SIDECAR = 'dist/sidecar/index.js'

for (const [what, path] of [
  ['renderer', `${RENDERER}/tauri.html`],
  ['sidecar', SIDECAR],
] as const) {
  if (!existsSync(path)) {
    console.error(`${path} is missing — build the ${what} with \`pnpm build:servo\` first.`)
    process.exit(1)
  }
}

const shell = await ensureTauriShell()
console.log(`[servo] ${shell}`)

const child = spawn(shell, [], {
  stdio: 'inherit',
  env: {
    ...process.env,
    TAURI_SHELL_FRONTEND_DIR: resolve(RENDERER),
    TAURI_SHELL_SIDECAR_ENTRY: resolve(SIDECAR),
    // Our own origin rather than the shell's neutral default. The page is
    // served from here, so this is what CSP 'self' resolves to and what any
    // origin-scoped storage is keyed by — worth owning, and worth keeping
    // stable, since changing it later would orphan anything stored under it.
    TAURI_SHELL_SCHEME: 'copse',
  },
})
child.on('exit', (code, signal) => {
  process.exit(signal !== null ? 1 : (code ?? 0))
})
