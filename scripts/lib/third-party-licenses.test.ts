import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  buildLicenseReport,
  bundledPackageDirs,
  collectPackages,
  declaredLicense,
  detectLicense,
  findLicenseProblems,
  isGplFamilyOnly,
  isLicenseFileName,
  packageDirOfInput,
  productionPackageDirs,
  readPackageLicenseFiles,
  renderLicenseReportText,
  sourceUrl,
  type CollectedComponent,
} from './third-party-licenses.mts'

const MIT = 'Permission is hereby granted, free of charge, to any person obtaining a copy'

function writePackage(
  dir: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = { LICENSE: `MIT License\n\n${MIT}\n` },
): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
}

function component(overrides: Partial<CollectedComponent> = {}): CollectedComponent {
  return {
    name: 'pkg',
    version: '1.0.0',
    license: 'MIT',
    source: null,
    shippedAs: ['bundled'],
    partOf: null,
    files: [{ name: 'LICENSE', text: MIT }],
    ...overrides,
  }
}

describe('licence file names', () => {
  it('accepts licence, notice and third-party notice files', () => {
    for (const name of [
      'LICENSE',
      'LICENCE.md',
      'license.txt',
      'LICENSE-MIT',
      'COPYING',
      'NOTICE',
      'ThirdPartyNotices.txt',
      'OFL.txt',
      'UNLICENSE',
    ]) {
      assert.ok(isLicenseFileName(name), name)
    }
  })

  it('rejects source files that share the stem', () => {
    for (const name of ['license.js', 'LICENSE.d.ts', 'licenses.json', 'README.md', 'notice.cjs']) {
      assert.ok(!isLicenseFileName(name), name)
    }
  })
})

describe('declared licences', () => {
  it('reads the string, object and legacy array forms', () => {
    assert.equal(declaredLicense({ license: 'MIT' }), 'MIT')
    assert.equal(declaredLicense({ license: { type: 'ISC' } }), 'ISC')
    assert.equal(
      declaredLicense({ licenses: [{ type: 'MIT' }, 'Apache-2.0'] }),
      '(MIT OR Apache-2.0)',
    )
    assert.equal(declaredLicense({}), 'UNKNOWN')
  })

  it('treats a package as GPL-family only when no alternative avoids the GPL', () => {
    assert.ok(isGplFamilyOnly('GPL-3.0-only'))
    assert.ok(isGplFamilyOnly('LGPL-2.1-or-later'))
    assert.ok(isGplFamilyOnly('AGPL-3.0'))
    assert.ok(isGplFamilyOnly('(LGPL-3.0 OR GPL-2.0)'))
    assert.ok(isGplFamilyOnly('MIT AND LGPL-2.1'))
    assert.ok(!isGplFamilyOnly('(BSD-3-Clause OR GPL-2.0)'), 'node-forge is dual-licensed')
    assert.ok(!isGplFamilyOnly('(MPL-2.0 OR Apache-2.0)'))
    assert.ok(!isGplFamilyOnly('MIT'))
    assert.ok(!isGplFamilyOnly('UNKNOWN'))
  })

  it('recognises common licence texts', () => {
    assert.equal(detectLicense(`MIT License\n${MIT}`), 'MIT')
    assert.equal(detectLicense('Apache License\n  Version 2.0, January 2004'), 'Apache-2.0')
    assert.equal(
      detectLicense('Redistribution and use in source and binary forms ... Neither the name of'),
      'BSD-3-Clause',
    )
    assert.equal(detectLicense('Redistribution and use in source and binary forms'), 'BSD-2-Clause')
    assert.equal(
      detectLicense('GNU LESSER GENERAL PUBLIC LICENSE\nincorporates GNU GENERAL PUBLIC LICENSE'),
      'LGPL',
    )
    assert.equal(detectLicense('all rights reserved'), 'UNKNOWN')
  })

  it('normalises repository URLs', () => {
    assert.equal(
      sourceUrl({ repository: { url: 'git+https://github.com/novnc/noVNC.git' } }),
      'https://github.com/novnc/noVNC',
    )
    assert.equal(
      sourceUrl({ repository: 'github:fb55/boolbase' }),
      'https://github.com/fb55/boolbase',
    )
    assert.equal(sourceUrl({ repository: 'fb55/boolbase' }), 'https://github.com/fb55/boolbase')
    assert.equal(sourceUrl({ homepage: 'https://example.com' }), 'https://example.com')
    assert.equal(sourceUrl({}), null)
  })
})

describe('esbuild inputs', () => {
  const root = '/repo'

  it('maps pnpm and plain node_modules inputs to their package root', () => {
    assert.equal(
      packageDirOfInput('node_modules/.pnpm/zod@4.6.5/node_modules/zod/v4/core/api.js', root),
      '/repo/node_modules/.pnpm/zod@4.6.5/node_modules/zod',
    )
    assert.equal(
      packageDirOfInput(
        'node_modules/.pnpm/@xterm+xterm@6.0.0/node_modules/@xterm/xterm/lib/xterm.mjs',
        root,
      ),
      '/repo/node_modules/.pnpm/@xterm+xterm@6.0.0/node_modules/@xterm/xterm',
    )
    assert.equal(
      packageDirOfInput('node_modules/a/node_modules/b/index.js', root),
      '/repo/node_modules/a/node_modules/b',
    )
  })

  it('treats first-party inputs as no package', () => {
    assert.equal(packageDirOfInput('src/renderer/main.ts', root), null)
    assert.equal(packageDirOfInput('packages/std/src/nullish.ts', root), null)
  })
})

describe('licence files inside a package', () => {
  const pkg = realpathSync(mkdtempSync(join(tmpdir(), 'copse-licenses-pkg-')))
  after(() => {
    rmSync(pkg, { recursive: true, force: true })
  })
  // noVNC's shape: a root summary, the full texts under docs/, and a vendored
  // library with its own licence under vendor/.
  writePackage(pkg, { name: '@novnc/novnc', version: '1.7.0' }, { 'LICENSE.txt': 'summary' })
  mkdirSync(join(pkg, 'docs'))
  writeFileSync(join(pkg, 'docs', 'LICENSE.MPL-2.0'), 'Mozilla Public License Version 2.0')
  writeFileSync(join(pkg, 'docs', 'API.md'), 'not a licence')
  mkdirSync(join(pkg, 'vendor', 'pako', 'lib', 'zlib'), { recursive: true })
  writeFileSync(join(pkg, 'vendor', 'pako', 'LICENSE'), MIT)
  mkdirSync(join(pkg, 'vendor', 'unused'))
  writeFileSync(join(pkg, 'vendor', 'unused', 'LICENSE'), 'never bundled')

  it('reads the root, the docs/ texts and the licences above bundled files', () => {
    assert.deepEqual(
      readPackageLicenseFiles(pkg, ['vendor/pako/lib/zlib', 'core']).map((f) => f.name),
      ['LICENSE.txt', 'docs/LICENSE.MPL-2.0', 'vendor/pako/LICENSE'],
    )
  })

  it('leaves out a vendored licence when nothing under it was bundled', () => {
    assert.deepEqual(
      readPackageLicenseFiles(pkg).map((f) => f.name),
      ['LICENSE.txt', 'docs/LICENSE.MPL-2.0'],
    )
  })
})

describe('dependency closure', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'copse-licenses-')))
  after(() => {
    rmSync(root, { recursive: true, force: true })
  })
  const nm = join(root, 'node_modules')
  // pnpm layout: the real package lives under .pnpm, its dependencies are
  // siblings there, and the top level holds symlinks to direct dependencies.
  const store = (name: string): string => join(nm, '.pnpm', `${name}@1.0.0`, 'node_modules', name)

  writePackage(root, {
    name: 'app',
    version: '0.0.0',
    dependencies: { direct: '1' },
    optionalDependencies: { 'optional-present': '1', 'optional-missing': '1' },
    devDependencies: { devonly: '1' },
  })
  writePackage(store('direct'), {
    name: 'direct',
    version: '1.0.0',
    license: 'MIT',
    dependencies: { transitive: '1' },
    peerDependencies: { peer: '1' },
  })
  writePackage(join(nm, '.pnpm', 'direct@1.0.0', 'node_modules', 'transitive'), {
    name: 'transitive',
    version: '2.0.0',
    license: 'ISC',
  })
  writePackage(store('optional-present'), { name: 'optional-present', version: '1.0.0' })
  writePackage(store('devonly'), { name: 'devonly', version: '1.0.0' })
  writePackage(store('peer'), { name: 'peer', version: '1.0.0' })
  for (const name of ['direct', 'optional-present', 'devonly', 'peer']) {
    symlinkSync(store(name), join(nm, name))
  }

  it('follows dependencies and installed optional dependencies, not dev or peer ones', () => {
    const names = [...productionPackageDirs(root)].map((dir) => dir.split('/').at(-1)).sort()
    assert.deepEqual(names, ['direct', 'optional-present', 'transitive'])
  })

  it('fails when a required dependency is not installed', () => {
    const broken = realpathSync(mkdtempSync(join(tmpdir(), 'copse-licenses-broken-')))
    try {
      writePackage(broken, { name: 'app', version: '0.0.0', dependencies: { absent: '1' } })
      assert.throws(() => productionPackageDirs(broken), /absent .* is not installed/)
    } finally {
      rmSync(broken, { recursive: true, force: true })
    }
  })

  it('merges bundled and packaged sightings of one package, skipping first-party code', () => {
    writePackage(join(root, 'packages', 'std'), { name: '@copse/std', version: '0.0.0' })
    const bundled = bundledPackageDirs(
      [
        {
          inputs: {
            'node_modules/direct/index.js': {},
            'node_modules/devonly/index.js': {},
            'packages/std/src/index.ts': {},
          },
        },
      ],
      root,
    )
    const components = collectPackages({
      rootDir: root,
      bundled,
      production: productionPackageDirs(root),
    })
    const byName = new Map(components.map((c) => [c.name, c]))
    const byNameDir = (name: string): string => store(name)
    assert.deepEqual([...(bundled.get(byNameDir('direct')) ?? [])], [''])
    assert.deepEqual(byName.get('direct')?.shippedAs, ['bundled', 'node_modules'])
    assert.deepEqual(byName.get('devonly')?.shippedAs, ['bundled'])
    assert.deepEqual(byName.get('transitive')?.shippedAs, ['node_modules'])
    assert.equal(byName.get('transitive')?.license, 'ISC')
    assert.equal(byName.get('direct')?.files[0]?.name, 'LICENSE')
    assert.ok(!byName.has('@copse/std'))
  })
})

describe('report', () => {
  it('flags a component with no licence text unless the gap is explained', () => {
    assert.deepEqual(findLicenseProblems([component({ files: [] })]), [
      { component: 'pkg@1.0.0', problem: 'no licence file (declares MIT)' },
    ])
    assert.deepEqual(findLicenseProblems([component({ files: [], note: 'upstream has none' })]), [])
  })

  it('flags a GPL-family-only component', () => {
    assert.deepEqual(findLicenseProblems([component({ license: 'LGPL-3.0-or-later' })]), [
      { component: 'pkg@1.0.0', problem: 'GPL-family licence LGPL-3.0-or-later' },
    ])
  })

  it('deduplicates texts, merges repeats and sorts by name', () => {
    const report = buildLicenseReport([
      component({ name: 'b' }),
      component({ name: 'a' }),
      component({ name: 'b', shippedAs: ['node_modules'] }),
    ])
    assert.deepEqual(
      report.components.map((c) => [c.name, c.shippedAs]),
      [
        ['a', ['bundled']],
        ['b', ['bundled', 'node_modules']],
      ],
    )
    assert.deepEqual(report.texts, [MIT])
    assert.deepEqual(report.components[0]?.files, [{ name: 'LICENSE', text: 0 }])
  })

  it('renders every component with its licence text', () => {
    const report = buildLicenseReport([
      component({ name: 'noVNC', license: 'MPL-2.0', source: 'https://github.com/novnc/noVNC' }),
      component({ name: 'go-mod', partOf: 'gortex', note: 'fork of x' }),
    ])
    const text = renderLicenseReportText(report, 'Preamble')
    assert.match(text, /^Preamble\n/)
    assert.match(
      text,
      /noVNC 1\.0\.0\nLicense: MPL-2\.0\nSource: https:\/\/github\.com\/novnc\/noVNC/,
    )
    assert.match(text, /go-mod 1\.0\.0[\s\S]*Included as: compiled into gortex\nNote: fork of x/)
    assert.equal(text.split(MIT).length - 1, 2)
  })
})
