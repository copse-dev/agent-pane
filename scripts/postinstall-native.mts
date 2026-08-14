import { accessSync, chmodSync, constants, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveDepRoot } from './resolve-dep.mts'

/**
 * node-pty ships spawn-helper without the executable bit (prebuilds); PTY spawn
 * then fails with posix_spawnp. After electron-rebuild, loadNativeModule prefers
 * `build/Release`, so chmod both trees. Verify X_OK so a skipped/no-op chmod
 * fails the install instead of shipping a broken terminal.
 */
function ensureNodePtySpawnHelperExecutable(): void {
  let nodePtyRoot: string
  try {
    nodePtyRoot = resolveDepRoot('node-pty')
  } catch {
    return
  }
  if (!existsSync(nodePtyRoot)) return

  const fixed: string[] = []
  const queue = [nodePtyRoot]
  for (let dir = queue.pop(); dir !== undefined; dir = queue.pop()) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      const stat = statSync(path)
      if (stat.isDirectory()) {
        queue.push(path)
        continue
      }
      if (entry !== 'spawn-helper') continue
      chmodSync(path, 0o755)
      accessSync(path, constants.X_OK)
      fixed.push(path)
    }
  }
  if (fixed.length > 0) {
    console.log(`[postinstall] node-pty spawn-helper executable (${String(fixed.length)} path(s))`)
  }
}

ensureNodePtySpawnHelperExecutable()

if (process.env['SKIP_ELECTRON_REBUILD'] === '1') {
  console.log('[postinstall] SKIP_ELECTRON_REBUILD=1 — skipping node-pty electron-rebuild')
  process.exit(0)
}

// Invoke the LOCAL electron-rebuild CLI (pinned devDependency) instead of
// `npx electron-rebuild`. `npx` would implicitly fetch-and-execute an unpinned
// version from the network if it were ever missing locally; resolving the
// already-installed package avoids any implicit network fetch and arbitrary
// lifecycle-script execution (supply-chain hardening, finding L5).
let rebuildCli: string
try {
  rebuildCli = join(resolveDepRoot('electron-rebuild'), 'lib', 'src', 'cli.js')
} catch {
  console.error(
    '[postinstall] electron-rebuild package not found. ' +
      'It is a pinned devDependency — run a full `pnpm install` first, ' +
      'or set SKIP_ELECTRON_REBUILD=1 to skip the native rebuild.',
  )
  process.exit(1)
}

if (!existsSync(rebuildCli)) {
  console.error(
    `[postinstall] electron-rebuild CLI not found at ${rebuildCli}. ` +
      'It is a pinned devDependency — run a full `pnpm install` first, ' +
      'or set SKIP_ELECTRON_REBUILD=1 to skip the native rebuild.',
  )
  process.exit(1)
}

const result = spawnSync(process.execPath, [rebuildCli, '-f', '-w', 'node-pty'], {
  stdio: 'inherit',
})

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

ensureNodePtySpawnHelperExecutable()
