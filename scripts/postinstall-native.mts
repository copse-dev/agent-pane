import { spawnSync } from 'node:child_process'

if (process.env.SKIP_ELECTRON_REBUILD === '1') {
  console.log('[postinstall] SKIP_ELECTRON_REBUILD=1 — skipping node-pty electron-rebuild')
  process.exit(0)
}

const result = spawnSync('npx', ['electron-rebuild', '-f', '-w', 'node-pty'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}
