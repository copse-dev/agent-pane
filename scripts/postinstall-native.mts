import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/** node-pty prebuilds ship spawn-helper without the executable bit; PTY spawn fails with posix_spawnp. */
function ensureNodePtySpawnHelperExecutable(): void {
  const prebuildsRoot = join(process.cwd(), 'node_modules', 'node-pty', 'prebuilds')
  if (!existsSync(prebuildsRoot)) return

  const queue = [prebuildsRoot]
  while (queue.length > 0) {
    const dir = queue.pop()!
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      const stat = statSync(path)
      if (stat.isDirectory()) {
        queue.push(path)
        continue
      }
      if (entry === 'spawn-helper') {
        chmodSync(path, 0o755)
      }
    }
  }
}

ensureNodePtySpawnHelperExecutable()

if (process.env['SKIP_ELECTRON_REBUILD'] === '1') {
  console.log('[postinstall] SKIP_ELECTRON_REBUILD=1 — skipping node-pty electron-rebuild')
  process.exit(0)
}

// Invoke the LOCAL electron-rebuild binary (pinned devDependency) instead of
// `npx electron-rebuild`. `npx` would implicitly fetch-and-execute an unpinned
// version from the network if it were ever missing locally; resolving the
// already-installed bin avoids any implicit network fetch and arbitrary
// lifecycle-script execution (supply-chain hardening, finding L5).
const rebuildBin = join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild',
)

if (!existsSync(rebuildBin)) {
  console.error(
    `[postinstall] electron-rebuild not found at ${rebuildBin}. ` +
      'It is a pinned devDependency — run a full `npm install` first, ' +
      'or set SKIP_ELECTRON_REBUILD=1 to skip the native rebuild.',
  )
  process.exit(1)
}

const result = spawnSync(rebuildBin, ['-f', '-w', 'node-pty'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

ensureNodePtySpawnHelperExecutable()
