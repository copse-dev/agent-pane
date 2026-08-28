import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { assembleMacosRelease } from './assemble-macos-release.mts'

const version = '1.2.3-beta.4'
let root = ''

function sha512(contents: string): string {
  return createHash('sha512').update(contents).digest('base64')
}

function seedArchitecture(arch: 'arm64' | 'x64', releaseDate: string): void {
  const directory = join(root, 'input', arch)
  mkdirSync(directory, { recursive: true })
  const files = [`Copse-${version}-${arch}.zip`, `Copse-${version}-${arch}.dmg`]
  for (const name of files) {
    const contents = `${name}-contents`
    writeFileSync(join(directory, name), contents)
    writeFileSync(join(directory, `${name}.blockmap`), `${name}-blockmap`)
  }
  writeFileSync(
    join(directory, `beta-mac.${arch}.yml`),
    [
      `version: ${version}`,
      'files:',
      ...files.flatMap((name) => [
        `  - url: ${name}`,
        `    sha512: ${sha512(`${name}-contents`)}`,
        `    size: ${String(Buffer.byteLength(`${name}-contents`))}`,
      ]),
      `releaseDate: '${releaseDate}'`,
      '',
    ].join('\n'),
  )
}

describe('assembleMacosRelease', () => {
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'copse-release-assembly-test-'))
  })
  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('combines architecture packages into one updater feed and checksum manifest', async () => {
    seedArchitecture('arm64', '2026-01-02T03:04:05.000Z')
    seedArchitecture('x64', '2026-01-02T03:04:06.000Z')
    const output = join(root, 'output')
    await assembleMacosRelease(version, join(root, 'input'), output)

    const metadata = readFileSync(join(output, 'beta-mac.yml'), 'utf8')
    for (const arch of ['arm64', 'x64']) {
      assert.match(metadata, new RegExp(`url: Copse-${version}-${arch}\\.zip`))
      assert.match(metadata, new RegExp(`url: Copse-${version}-${arch}\\.dmg`))
    }
    assert.match(metadata, /path: Copse-1\.2\.3-beta\.4-x64\.zip/)
    assert.match(metadata, /releaseDate: '2026-01-02T03:04:06\.000Z'/)

    const checksums = readFileSync(join(output, 'SHA256SUMS'), 'utf8')
    assert.match(checksums, / {2}Copse-1\.2\.3-beta\.4-arm64\.dmg$/m)
    assert.match(checksums, / {2}Copse-1\.2\.3-beta\.4-x64\.zip\.blockmap$/m)
    assert.match(checksums, / {2}beta-mac\.yml$/m)
  })

  it('fails closed when an architecture artifact is incomplete', async () => {
    rmSync(join(root, 'input', 'x64', `Copse-${version}-x64.dmg.blockmap`))
    await assert.rejects(
      assembleMacosRelease(version, join(root, 'input'), join(root, 'incomplete-output')),
      /Expected 4 packages and 4 blockmaps/,
    )
  })
})
