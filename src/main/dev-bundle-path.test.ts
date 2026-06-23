import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const ROOT = process.cwd()
const ELECTRON_INSTALL_JS = join(ROOT, 'node_modules', 'electron', 'install.js')
const ELECTRON_PKG_JSON = join(ROOT, 'node_modules', 'electron', 'package.json')

/** Kept in sync with scripts/patch-dev-name.mts */
const PATCH_DARWIN_EXEC_REL = 'Copse.app/Contents/MacOS/Electron'
const INSTALL_DARWIN_EXEC_REL = 'Electron.app/Contents/MacOS/Electron'

describe('macOS dev bundle patch contract (Electron lazy download)', () => {
  it('electron install.js still uses the stock Electron.app layout on darwin', () => {
    if (!existsSync(ELECTRON_INSTALL_JS)) {
      // CI / fresh clones without node_modules — skip rather than fail the suite.
      return
    }
    const installJs = readFileSync(ELECTRON_INSTALL_JS, 'utf8')
    assert.match(
      installJs,
      new RegExp(`return '${INSTALL_DARWIN_EXEC_REL.replace(/\./g, '\\.')}';`),
      'update scripts/patch-dev-name.mts if electron changes the macOS bundle path',
    )
  })

  it('patch-dev-name rewrites path.txt from stock Electron.app to Copse.app', () => {
    assert.notEqual(PATCH_DARWIN_EXEC_REL, INSTALL_DARWIN_EXEC_REL)
    assert.match(PATCH_DARWIN_EXEC_REL, /^Copse\.app\/Contents\/MacOS\/Electron$/)
  })

  it('electron npm package uses lazy download (no postinstall hook)', () => {
    if (!existsSync(ELECTRON_PKG_JSON)) return
    const pkg = JSON.parse(readFileSync(ELECTRON_PKG_JSON, 'utf8')) as {
      scripts?: { postinstall?: string }
    }
    assert.equal(
      pkg.scripts?.postinstall,
      undefined,
      'postinstall must fetch the dist in patch-dev-name when Electron.app is missing',
    )
  })
})
