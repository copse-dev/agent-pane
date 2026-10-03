import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
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

function isInstalledPackage(root: string, name: string): boolean {
  if (existsSync(join(root, 'node_modules', name, 'package.json'))) return true
  const virtualStore = join(root, 'node_modules', '.pnpm')
  let entries: string[]
  try {
    entries = readdirSync(virtualStore)
  } catch {
    return false
  }
  return entries.some((entry) =>
    existsSync(join(virtualStore, entry, 'node_modules', name, 'package.json')),
  )
}

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
  it('matches the node_modules closure the app ships', () => {
    const problems = findNoticeProblems(notices, components, { complete: false })
    assert.deepEqual(problems, [], formatNoticeProblems(problems))
  })

  it('names only packages that are still installed', () => {
    const shipped = new Set(components.map((component) => component.name))
    const missing = notices.entries
      .map((entry) => entry.packageName)
      .filter((name) => !shipped.has(name) && !isInstalledPackage(root, name))
    assert.deepEqual(missing, [])
  })
})

describe('installed package lookup', () => {
  it("finds a package linked only beneath pnpm's virtual store", () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-notice-install-'))
    try {
      const nested = join(
        root,
        'node_modules',
        '.pnpm',
        'build-tool@1.0.0',
        'node_modules',
        'bundled-only',
      )
      mkdirSync(nested, { recursive: true })
      writeFileSync(join(nested, 'package.json'), '{"name":"bundled-only","version":"1.0.0"}')

      assert.equal(isInstalledPackage(root, 'bundled-only'), true)
      assert.equal(isInstalledPackage(root, 'removed-package'), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
