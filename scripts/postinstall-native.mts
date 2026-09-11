import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { expectRecord, expectString, parseJsonUnknown } from '../src/shared/unknown-value.mts'
import { resolveDepRoot } from './resolve-dep.mts'
import { createRequire } from 'node:module'
import { prepareElectronHeaders } from './lib/electron-headers.mts'

/**
 * node-pty ships spawn-helper without the executable bit (prebuilds); PTY spawn
 * then fails with posix_spawnp. After the rebuild, loadNativeModule prefers
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

const { rebuild } = await import('@electron/rebuild')

// The pinned API lets us bound module discovery to this execution root. The
// CLI searches ancestor lockfiles and can select another checkout's dependencies.
const electron = expectRecord(
  parseJsonUnknown(readFileSync(join(resolveDepRoot('electron'), 'package.json'), 'utf8')),
  'Electron package',
)
const electronVersion = expectString(electron['version'], 'Electron version')
const headerCache = process.env['COPSE_ELECTRON_HEADERS_CACHE']
if (headerCache) {
  process.env['npm_package_config_node_gyp_nodedir'] = prepareElectronHeaders({
    cache: headerCache,
    version: electronVersion,
    nodeGypCli: createRequire(join(resolveDepRoot('@electron/rebuild'), 'package.json')).resolve(
      'node-gyp/bin/node-gyp.js',
    ),
    offline: process.env['COPSE_PORTABLE_OFFLINE'] === '1',
  })
}
await rebuild({
  buildPath: process.cwd(),
  projectRootPath: process.cwd(),
  electronVersion,
  force: true,
  onlyModules: ['node-pty'],
})

ensureNodePtySpawnHelperExecutable()
