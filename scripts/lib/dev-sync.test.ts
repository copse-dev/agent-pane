import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'
import {
  BUILD_SENTINELS,
  DEPENDENCY_SENTINELS,
  DEV_STATE,
  buildIsCurrent,
  buildOutputsFingerprint,
  dependenciesAreCurrent,
  dependencyFingerprint,
  fingerprintPaths,
  type DependencyContextFingerprint,
  writeFingerprint,
} from './dev-sync.mts'

const root = mkdtempSync(join(tmpdir(), 'copse-dev-sync-'))

after(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

function write(path: string, value: string): void {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, value)
}

describe('fingerprintPaths', () => {
  it('detects byte edits even when the mtime is preserved', () => {
    write('src/example.ts', 'before')
    const timestamp = new Date('2020-01-01T00:00:00Z')
    utimesSync(join(root, 'src/example.ts'), timestamp, timestamp)
    const before = fingerprintPaths(root, ['src'])

    write('src/example.ts', 'after!')
    utimesSync(join(root, 'src/example.ts'), timestamp, timestamp)

    assert.notEqual(fingerprintPaths(root, ['src']), before)
  })

  it('detects additions, deletions, renames, and symlink target changes', () => {
    write('src/a.ts', 'same bytes')
    write('targets/one', 'target')
    write('targets/two', 'target')
    symlinkSync('../targets/one', join(root, 'src/link'))
    const initial = fingerprintPaths(root, ['src'])

    write('src/b.ts', 'same bytes')
    const added = fingerprintPaths(root, ['src'])
    assert.notEqual(added, initial)

    rmSync(join(root, 'src/a.ts'))
    const deleted = fingerprintPaths(root, ['src'])
    assert.notEqual(deleted, added)

    rmSync(join(root, 'src/link'))
    symlinkSync('../targets/two', join(root, 'src/link'))
    assert.notEqual(fingerprintPaths(root, ['src']), deleted)
  })
})

describe('dependencyFingerprint', () => {
  const runtime: DependencyContextFingerprint = {
    node: '22.22.2',
    nodeModulesAbi: '127',
    platform: 'darwin',
    arch: 'arm64',
  }

  it('includes nested workspace manifests and the runtime ABI', () => {
    write('package.json', '{"name":"root"}')
    write('packages/example/package.json', '{"name":"example"}')
    const initial = dependencyFingerprint(root, runtime)

    write('packages/example/package.json', '{"name":"renamed"}')
    assert.notEqual(dependencyFingerprint(root, runtime), initial)

    write('packages/example/package.json', '{"name":"example"}')
    assert.notEqual(dependencyFingerprint(root, { ...runtime, nodeModulesAbi: '128' }), initial)
  })

  it('requires both the recorded fingerprint and install sentinels', () => {
    const expected = dependencyFingerprint(root, runtime)
    writeFingerprint(root, DEV_STATE.dependencies, expected)
    assert.equal(dependenciesAreCurrent(root, expected), false)

    for (const sentinel of DEPENDENCY_SENTINELS) write(sentinel, 'present')
    assert.equal(dependenciesAreCurrent(root, expected), true)
  })
})

describe('buildIsCurrent', () => {
  it('rejects missing, watch-mode, and byte-modified outputs', () => {
    const expected = 'a'.repeat(64)
    for (const sentinel of BUILD_SENTINELS) write(sentinel, `built:${sentinel}`)
    writeFingerprint(root, DEV_STATE.build, expected)
    writeFingerprint(root, DEV_STATE.distMarker, expected)
    writeFingerprint(root, DEV_STATE.buildOutputs, buildOutputsFingerprint(root))
    assert.equal(buildIsCurrent(root, expected), true)

    write(BUILD_SENTINELS[0], 'watch output')
    assert.equal(buildIsCurrent(root, expected), false)

    write(BUILD_SENTINELS[0], `built:${BUILD_SENTINELS[0]}`)
    writeFingerprint(root, DEV_STATE.buildOutputs, buildOutputsFingerprint(root))
    rmSync(join(root, DEV_STATE.distMarker))
    assert.equal(buildIsCurrent(root, expected), false)
  })

  it('covers auxiliary resources, not just the required sentinels', () => {
    for (const sentinel of BUILD_SENTINELS) write(sentinel, `built:${sentinel}`)
    write('dist/resources/helper', 'version one')
    const before = buildOutputsFingerprint(root)

    write('dist/resources/helper', 'version two')
    assert.notEqual(buildOutputsFingerprint(root), before)
  })
})
