import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  compareNpmVersions,
  isNpmVersionOlder,
  npmBinBesideBinary,
  parseNpmVersionTuple,
  readInstalledNpmPackageVersion,
  resetAcpAdapterLatestCache,
} from './acp-adapter-version.ts'

afterEach(() => {
  resetAcpAdapterLatestCache()
})

describe('parseNpmVersionTuple / compareNpmVersions', () => {
  it('parses dotted numeric versions and strips prerelease metadata', () => {
    assert.deepEqual(parseNpmVersionTuple('1.1.7'), [1, 1, 7])
    assert.deepEqual(parseNpmVersionTuple('v1.1.0-beta.1'), [1, 1, 0])
    assert.equal(parseNpmVersionTuple('not-a-version'), null)
    assert.equal(parseNpmVersionTuple('1.x.0'), null)
  })

  it('orders versions and treats garbage as not-older', () => {
    assert.ok(compareNpmVersions('1.1.0', '1.1.7') < 0)
    assert.ok(compareNpmVersions('1.2.0', '1.1.9') > 0)
    assert.equal(compareNpmVersions('1.1.0', '1.1.0'), 0)
    assert.equal(isNpmVersionOlder('1.1.0', '1.1.7'), true)
    assert.equal(isNpmVersionOlder('1.1.7', '1.1.0'), false)
    assert.equal(isNpmVersionOlder('nope', '1.1.7'), false)
  })

  it('orders prereleases before stable releases and by prerelease identifier', () => {
    assert.equal(isNpmVersionOlder('1.1.0-beta.1', '1.1.0'), true)
    assert.equal(isNpmVersionOlder('1.1.0-beta.1', '1.1.0-beta.2'), true)
    assert.equal(isNpmVersionOlder('1.1.0-beta.2', '1.1.0-beta.1'), false)
    assert.equal(compareNpmVersions('1.1.0+local.1', '1.1.0+registry.2'), 0)
  })

  it('follows SemVer prerelease precedence across numeric and text identifiers', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ]
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1]
      const current = ordered[i]
      assert.ok(previous && current)
      assert.ok(compareNpmVersions(previous, current) < 0, `${previous} should precede ${current}`)
    }
  })
})

describe('readInstalledNpmPackageVersion', () => {
  it('follows a bin symlink into node_modules and reads the matching package.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-adapter-version-'))
    const pkgDir = join(root, 'lib', 'node_modules', '@agentclientprotocol', 'codex-acp')
    const distDir = join(pkgDir, 'dist')
    mkdirSync(distDir, { recursive: true })
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@agentclientprotocol/codex-acp', version: '1.1.0' }),
    )
    writeFileSync(join(distDir, 'index.js'), '#!/usr/bin/env node\n')
    const binDir = join(root, 'bin')
    mkdirSync(binDir, { recursive: true })
    const binPath = join(binDir, 'codex-acp')
    symlinkSync(join(distDir, 'index.js'), binPath)

    assert.equal(
      await readInstalledNpmPackageVersion(binPath, '@agentclientprotocol/codex-acp'),
      '1.1.0',
    )
    assert.equal(await readInstalledNpmPackageVersion(binPath, '@other/pkg'), null)
  })
})

describe('npmBinBesideBinary', () => {
  it('prefers the npm sibling of the binary when present', () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-npm-beside-'))
    const binDir = join(root, 'bin')
    mkdirSync(binDir, { recursive: true })
    const agent = join(binDir, 'codex-acp')
    const npm = join(binDir, 'npm')
    writeFileSync(agent, '')
    writeFileSync(npm, '')
    assert.equal(npmBinBesideBinary(agent), npm)
  })

  it('falls back to PATH npm when the sibling is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-npm-fallback-'))
    const agent = join(root, 'codex-acp')
    writeFileSync(agent, '')
    assert.equal(npmBinBesideBinary(agent), 'npm')
  })
})
