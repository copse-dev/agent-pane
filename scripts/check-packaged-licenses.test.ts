import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  THIRD_PARTY_LICENSE_JSON,
  THIRD_PARTY_LICENSES_DIR,
} from '../src/shared/third-party-licenses.mts'
import { findPackagedLicenseProblems, packageManifestPaths } from './check-packaged-licenses.mts'
import { openAsar, type AsarArchive } from './lib/asar-archive.mts'

const LICENSE_FILES = [
  'third-party-licenses.json',
  'THIRD_PARTY_LICENSES.txt',
  'LICENSES.chromium.html.gz',
  'LICENSE.txt',
].map((name) => `${THIRD_PARTY_LICENSES_DIR}/${name}`)

function fakeArchive(files: Record<string, unknown>): AsarArchive {
  return {
    files: Object.keys(files).sort(),
    readFile(path: string): Buffer {
      const value = files[path]
      return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
    },
  }
}

function withReport(
  components: { name: string; version: string }[],
  extra: Record<string, unknown>,
): AsarArchive {
  const files: Record<string, unknown> = Object.fromEntries(LICENSE_FILES.map((f) => [f, '']))
  files[`${THIRD_PARTY_LICENSES_DIR}/${THIRD_PARTY_LICENSE_JSON}`] = { components }
  return fakeArchive({ ...files, ...extra })
}

describe('packaged licence check', () => {
  it('finds package roots, not nested package.json markers', () => {
    assert.deepEqual(
      packageManifestPaths([
        'package.json',
        'node_modules/a/package.json',
        'node_modules/@s/b/package.json',
        'node_modules/a/node_modules/c/package.json',
        'node_modules/zod/v4/package.json',
        'node_modules/@s/b/dist/package.json',
      ]),
      [
        'node_modules/a/package.json',
        'node_modules/@s/b/package.json',
        'node_modules/a/node_modules/c/package.json',
      ],
    )
  })

  it('passes an app whose every module is in the report', () => {
    const archive = withReport([{ name: 'a', version: '1.0.0' }], {
      'node_modules/a/package.json': { name: 'a', version: '1.0.0', license: 'MIT' },
      'node_modules/zod/v4/package.json': { type: 'module' },
    })
    assert.deepEqual(findPackagedLicenseProblems(archive), [])
  })

  it('fails a module missing from the report', () => {
    const archive = withReport([], {
      'node_modules/a/package.json': { name: 'a', version: '1.0.0', license: 'MIT' },
    })
    assert.deepEqual(findPackagedLicenseProblems(archive), [
      `a@1.0.0 (node_modules/a/package.json) ships without an entry in ${THIRD_PARTY_LICENSE_JSON}`,
    ])
  })

  it('fails sharp and libvips whatever they declare, and GPL-only packages', () => {
    const packages = [
      { name: 'sharp', version: '0.35.4', license: 'Apache-2.0' },
      { name: '@img/sharp-libvips-darwin-arm64', version: '1.2.0', license: 'LGPL-3.0-or-later' },
      { name: 'gpl-thing', version: '1.0.0', license: 'GPL-3.0-only' },
      { name: 'node-forge', version: '1.4.0', license: '(BSD-3-Clause OR GPL-2.0)' },
    ]
    const archive = withReport(
      packages,
      Object.fromEntries(packages.map((p) => [`node_modules/${p.name}/package.json`, p])),
    )
    const problems = findPackagedLicenseProblems(archive).sort()
    assert.equal(problems.length, 3)
    assert.match(problems[0] ?? '', /^@img\/sharp-libvips-darwin-arm64@1\.2\.0 .* must not ship/)
    assert.match(problems[1] ?? '', /^gpl-thing@1\.0\.0 .* is GPL-3\.0-only/)
    assert.match(problems[2] ?? '', /^sharp@0\.35\.4 .* must not ship/)
  })

  it('fails an app with no licence files, as 0.1.0-beta.8 was', () => {
    const archive = fakeArchive({
      'node_modules/a/package.json': { name: 'a', version: '1.0.0', license: 'MIT' },
    })
    assert.deepEqual(
      findPackagedLicenseProblems(archive),
      LICENSE_FILES.map((path) => `${path} is not in the app`),
    )
  })
})

describe('asar archive reader', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copse-asar-'))
  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** The layout @electron/asar writes: size pickle, header pickle, then file data. */
  function writeAsar(path: string, header: unknown, data: Buffer): void {
    const json = Buffer.from(JSON.stringify(header))
    const padded = Math.ceil((4 + json.length) / 4) * 4
    const headerPickle = Buffer.alloc(4 + padded)
    headerPickle.writeUInt32LE(padded, 0)
    headerPickle.writeInt32LE(json.length, 4)
    json.copy(headerPickle, 8)
    const sizePickle = Buffer.alloc(8)
    sizePickle.writeUInt32LE(4, 0)
    sizePickle.writeUInt32LE(headerPickle.length, 4)
    writeFileSync(path, Buffer.concat([sizePickle, headerPickle, data]))
  }

  it('lists packed and present unpacked files and reads both back', () => {
    const asar = join(dir, 'app.asar')
    const packed = Buffer.from('{"name":"copse-panel"}')
    writeAsar(
      asar,
      {
        files: {
          'package.json': { size: packed.length, offset: '0' },
          dist: {
            files: {
              'kept.txt': { size: 4, unpacked: true },
              'deleted.txt': { size: 4, unpacked: true },
            },
          },
          'link.js': { link: 'package.json' },
        },
      },
      packed,
    )
    mkdirSync(join(`${asar}.unpacked`, 'dist'), { recursive: true })
    writeFileSync(join(`${asar}.unpacked`, 'dist', 'kept.txt'), 'kept')

    const archive = openAsar(asar)
    assert.deepEqual(archive.files, ['dist/kept.txt', 'package.json'])
    assert.equal(archive.readFile('package.json').toString(), '{"name":"copse-panel"}')
    assert.equal(archive.readFile('dist/kept.txt').toString(), 'kept')
  })

  it('rejects a file that is not an asar archive', () => {
    const bogus = join(dir, 'bogus.asar')
    writeFileSync(bogus, Buffer.alloc(16))
    assert.throws(() => openAsar(bogus), /not an asar archive/)
  })
})
