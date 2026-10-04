import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { removeMissingBuildArtifact } from './missing-build-artifact.mts'

it('removes stale copied helper and architecture-specific worker bytes when their sources disappear', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-missing-artifacts-'))
  try {
    for (const artifact of ['profile-vault/CopseVault', 'node/arm64/node', 'node/x64/node']) {
      const source = join(root, 'prepared', artifact)
      const destination = join(root, 'resources', artifact.slice(0, artifact.lastIndexOf('/')))
      mkdirSync(destination, { recursive: true })
      writeFileSync(join(root, 'resources', artifact), 'previous build')
      assert.equal(removeMissingBuildArtifact(source, destination), true)
      assert.equal(existsSync(destination), false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('leaves available sources for validation and never follows a stale destination symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-artifact-source-'))
  try {
    const source = join(root, 'source')
    const outside = join(root, 'outside')
    const destination = join(root, 'destination')
    writeFileSync(source, 'prepared bytes')
    mkdirSync(outside)
    writeFileSync(join(outside, 'untouched'), 'outside bytes')
    symlinkSync(outside, destination)
    assert.equal(removeMissingBuildArtifact(source, destination), false)
    assert.equal(existsSync(destination), true)
    rmSync(source)
    assert.equal(removeMissingBuildArtifact(source, destination), true)
    assert.equal(existsSync(destination), false)
    assert.equal(existsSync(join(outside, 'untouched')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
