import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import {
  declaredLicense,
  productionPackageDirs,
  readManifest,
} from './lib/third-party-licenses.mts'
import {
  findNoticeProblems,
  formatNoticeProblems,
  parseNotices,
  type ShippedComponent,
} from './lib/third-party-notices.mts'

/**
 * The unit-tier half of the THIRD_PARTY_NOTICES.md lint. Without a build there
 * is no esbuild metafile, so this sees only the node_modules closure
 * electron-builder copies into app.asar; the build checks the complete set
 * (bundles included) in `collectLicenseReport`.
 */
describe('THIRD_PARTY_NOTICES.md', () => {
  const root = realpathSync(resolve('.'))
  const notices = parseNotices(readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'))
  const components: ShippedComponent[] = [...productionPackageDirs(root)].map((dir) => {
    const manifest = readManifest(dir)
    return {
      name: manifest.name ?? dir,
      version: manifest.version ?? '',
      license: declaredLicense(manifest),
    }
  })
  const isTopLevel = (name: string): boolean =>
    existsSync(join(root, 'node_modules', name, 'package.json'))

  it('matches the node_modules closure the app ships', () => {
    const problems = findNoticeProblems(notices, components, { complete: false })
    assert.deepEqual(problems, [], formatNoticeProblems(problems))
  })

  it('quotes the installed version of every package it names', () => {
    const stale = notices.entries.flatMap((entry) => {
      // A transitive package (node-forge) is not linked at the top level under
      // pnpm; the closure check above compares its version instead.
      if (entry.version === null || !isTopLevel(entry.packageName)) return []
      const installed = readManifest(join(root, 'node_modules', entry.packageName)).version
      return installed === entry.version
        ? []
        : [`${entry.packageName}: entry says ${entry.version}, ${String(installed)} is installed`]
    })
    assert.deepEqual(stale, [])
  })

  it('names only packages that are still installed', () => {
    const shipped = new Set(components.map((component) => component.name))
    const missing = notices.entries
      .map((entry) => entry.packageName)
      .filter((name) => !shipped.has(name) && !isTopLevel(name))
    assert.deepEqual(missing, [])
  })
})
