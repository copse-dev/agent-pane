import { accessSync, chmodSync, constants, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDepRoot } from './resolve-dep.mts'

/**
 * node-pty is a Node-API addon, so one binary loads in Node and in every
 * Electron release. On macOS its install script selects the prebuild in
 * `prebuilds/darwin-<arch>`; elsewhere it compiles against Node's headers.
 * Neither needs an Electron-specific rebuild, so install compiles nothing on
 * macOS. Release packaging still lets electron-builder rebuild natives.
 *
 * node-pty ships spawn-helper without the executable bit, and PTY spawn then
 * fails with posix_spawnp. chmod every copy (prebuilds and any `build/Release`
 * left by an earlier rebuild) and verify X_OK, so a no-op chmod fails the
 * install instead of shipping a broken terminal.
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
