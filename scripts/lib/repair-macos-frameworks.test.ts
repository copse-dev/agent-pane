import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { repairVersionedMacosFrameworks } from './repair-macos-frameworks.mts'

function createFramework(root: string, name: string): string {
  const framework = join(root, `${name}.framework`)
  const version = join(framework, 'Versions', 'A')
  for (const directory of ['Headers', 'Modules', 'Resources']) {
    mkdirSync(join(version, directory), { recursive: true })
  }
  writeFileSync(join(version, name), 'Mach-O fixture')
  return framework
}

describe('repairVersionedMacosFrameworks', () => {
  it('restores the conventional links omitted from packaged frameworks', () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-frameworks-'))
    const framework = createFramework(root, 'FBControlCore')

    repairVersionedMacosFrameworks(root)

    assert.equal(readlinkSync(join(framework, 'Versions', 'Current')), 'A')
    assert.equal(readlinkSync(join(framework, 'FBControlCore')), 'Versions/Current/FBControlCore')
    for (const directory of ['Headers', 'Modules', 'Resources']) {
      assert.equal(readlinkSync(join(framework, directory)), `Versions/Current/${directory}`)
    }
    assert.doesNotThrow(() => {
      repairVersionedMacosFrameworks(root)
    })
  })

  it('fails closed when a framework is incomplete', () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-frameworks-'))
    const framework = createFramework(root, 'FBDeviceControl')
    rmSync(join(framework, 'Versions', 'A', 'Resources'), { recursive: true })

    assert.throws(() => {
      repairVersionedMacosFrameworks(root)
    }, /Cannot repair/)
  })
})
