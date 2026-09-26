import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { GORTEX_VERSION } from './lib/native-artifacts.mts'
import {
  collectPackages,
  findLicenseProblems,
  isLicenseFileName,
  productionPackageDirs,
  readPackageLicenseFiles,
} from './lib/third-party-licenses.mts'
import {
  COPIED_PACKAGES,
  ELECTRON_NOTICES,
  LICENSE_OVERRIDES,
  VENDORED_COMPONENTS,
  applyLicenseOverrides,
  readGortexLicenses,
  vendoredComponents,
} from './third-party-vendored.mts'

/**
 * Invariants that keep the shipped licence report complete. The build itself
 * fails on a bundled or packaged component with no licence text (see
 * scripts/write-third-party-licenses.mts), and after-pack.cjs checks the real
 * archive; these catch the inputs going stale without anyone building.
 */
describe('third-party licence inputs', () => {
  const root = resolve('.')
  const tracked = execFileSync('git', ['ls-files', 'src', 'assets', 'vendor'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((path) => path.length > 0)

  it('attributes every checked-in licence file to a component', () => {
    const declared = new Set([
      ...VENDORED_COMPONENTS.flatMap((component) => component.licenseFiles),
      ...Object.values(LICENSE_OVERRIDES).flatMap((o) => (o.licenseFile ? [o.licenseFile] : [])),
    ])
    const unattributed = tracked.filter((path) => {
      const name = path.split('/').at(-1) ?? ''
      if (!isLicenseFileName(name)) return false
      // Each Cursor plugin is read from its own directory; see cursorPluginComponents.
      if (path.startsWith('vendor/bundled-cursor-skills/plugins/')) return false
      return !declared.has(path)
    })
    assert.deepEqual(
      unattributed,
      [],
      'a licence file was checked in with third-party code: add the component to ' +
        'VENDORED_COMPONENTS in scripts/third-party-vendored.mts so it reaches the shipped report',
    )
  })

  it('declares every package the build copies files out of', () => {
    const copiers = [
      'scripts/build.mts',
      'scripts/copy-monaco-workers.mts',
      'scripts/write-mermaid-frame.mts',
    ]
    const copied = new Set<string>()
    for (const file of copiers) {
      for (const match of readFileSync(resolve(file), 'utf8').matchAll(
        /node_modules\/((?:@[\w.-]+\/)?[\w.-]+)/g,
      )) {
        if (match[1]) copied.add(match[1])
      }
    }
    assert.deepEqual([...copied].sort(), [...COPIED_PACKAGES].sort())
    assert.ok(ELECTRON_NOTICES.startsWith('node_modules/electron/dist/'))
  })

  it('keeps the gortex licence data in step with the gortex the app ships', () => {
    const gortex = readGortexLicenses()
    assert.equal(
      gortex.gortexVersion,
      GORTEX_VERSION,
      'GORTEX_VERSION moved: run `pnpm sync:gortex-licenses` and commit vendor/licenses/gortex.json',
    )
    assert.ok(gortex.modules.length > 0)
    for (const module of gortex.modules) {
      assert.ok(
        module.files.length > 0 || module.note,
        `${module.path} has neither a licence text nor a note saying why`,
      )
      assert.ok(!/GPL/.test(module.license), `${module.path} is ${module.license}`)
    }
    assert.deepEqual(
      gortex.gortex.files.map((file) => file.name),
      ['LICENSE.md', 'NOTICE'],
      'gortex is Apache-2.0: its NOTICE has to travel with the binary (§4(d))',
    )
  })

  it('gives every packaged dependency a licence, and ships no sharp or libvips', () => {
    const production = productionPackageDirs(root)
    const packages = applyLicenseOverrides(
      collectPackages({ rootDir: root, bundled: new Map(), production }),
      root,
    )
    assert.deepEqual(findLicenseProblems(packages), [])
    const names = packages.map((p) => p.name)
    assert.ok(
      names.includes('@nationaldesignstudio/rampart'),
      'fixture sanity: Rampart is packaged',
    )
    assert.deepEqual(
      names.filter((name) => /^(?:sharp|@img\/sharp-|@huggingface\/transformers)/.test(name)),
      [],
      'sharp/libvips (LGPL) must stay out of app.asar: see THIRD_PARTY_NOTICES.md',
    )
  })

  it("ships noVNC's full MPL-2.0 text, not only its summary", () => {
    // noVNC's root LICENSE.txt only names docs/LICENSE.MPL-2.0; the packaged app
    // (0.1.0-beta.8) carried neither, because noVNC is bundled, not packaged.
    const novnc = realpathSync(resolve('node_modules/@novnc/novnc'))
    const names = readPackageLicenseFiles(novnc, ['vendor/pako/lib/zlib']).map((f) => f.name)
    assert.ok(names.includes('docs/LICENSE.MPL-2.0'), names.join(', '))
    assert.ok(names.includes('vendor/pako/LICENSE'), names.join(', '))
  })

  it('reads every vendored component with its licence text', () => {
    const components = vendoredComponents(root)
    assert.deepEqual(findLicenseProblems(components), [])
    for (const name of ['electron', 'gortex', 'Pliant', 'drauu']) {
      assert.ok(
        components.some((c) => c.name === name),
        `${name} is missing from the vendored components`,
      )
    }
  })

  it('packages the licence files outside app.asar and checks the archive', () => {
    const pkg: unknown = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
    assert.ok(typeof pkg === 'object' && pkg !== null && 'build' in pkg)
    assert.match(JSON.stringify(pkg.build), /"dist\/resources\/licenses\/\*\*"/)
    const afterPack = readFileSync(resolve('scripts/after-pack.cjs'), 'utf8')
    assert.match(afterPack, /assertPackagedLicenses\(/)
    assert.ok(
      afterPack.indexOf('await checkLicenses(context)') <
        afterPack.indexOf("if (context.electronPlatformName !== 'darwin') return"),
      'the licence check must run on every platform, before the macOS-only steps',
    )
  })

  it('builds the report from every shipped bundle', () => {
    const build = readFileSync(resolve('scripts/build.mts'), 'utf8')
    // Two direct esbuild calls are allowed: `bundle()` itself, and the demo
    // scenario manifest, a temporary module that is deleted, not shipped.
    const direct = [...build.matchAll(/esbuild\.build\(/g)].length
    assert.equal(
      direct,
      2,
      'a shipped bundle bypassed bundle(), so its inputs miss the licence report',
    )
    assert.match(build, /esbuild\.build\(\{ \.\.\.options, metafile: true \}\)/)
    assert.match(build, /writeThirdPartyLicenses\(process\.cwd\(\), metafiles\)/)
  })
})
