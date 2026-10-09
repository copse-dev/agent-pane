import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { createVaultManifest, newVaultIdentity, VaultError } from './profile-vault-crypto.ts'
import {
  finishVaultEnrollment,
  prepareVaultEnrollment,
  readVaultEnrollment,
  writeVaultFile,
} from './profile-vault-files.ts'

it('persists only the enrollment identity and keeps it until a matching manifest is durable', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-enrollment-'))
  const key = randomBytes(32)
  try {
    assert.equal(readVaultEnrollment(root), null)
    const identity = prepareVaultEnrollment(root)
    const path = join(root, '.vault-enrollment.json')
    assert.equal(readFileSync(path, 'utf8'), JSON.stringify({ version: 1, ...identity }))
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.deepEqual(prepareVaultEnrollment(root), identity)
    finishVaultEnrollment(root)
    assert.deepEqual(readVaultEnrollment(root), identity)
    const manifest = createVaultManifest(key, identity, randomUUID(), 'c3ludGhldGlj')
    writeVaultFile(root, 'vault-manifest.json', JSON.stringify(manifest))
    finishVaultEnrollment(root)
    assert.equal(readVaultEnrollment(root), null)
  } finally {
    key.fill(0)
    rmSync(root, { recursive: true, force: true })
  }
})

it('rejects corrupt, symlinked and mismatched pending identities without discarding them', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-enrollment-corrupt-'))
  const key = randomBytes(32)
  try {
    const pendingPath = join(root, '.vault-enrollment.json')
    const identity = newVaultIdentity()
    for (const text of [
      'broken',
      JSON.stringify({ version: 1, ...identity, dataKey: 'forbidden' }),
    ]) {
      writeFileSync(pendingPath, text)
      assert.throws(() => prepareVaultEnrollment(root), VaultError)
      assert.equal(readFileSync(pendingPath, 'utf8'), text)
    }
    rmSync(pendingPath)
    const outside = join(root, 'outside.json')
    writeFileSync(outside, JSON.stringify({ version: 1, ...identity }))
    symlinkSync(outside, pendingPath)
    assert.throws(() => prepareVaultEnrollment(root), VaultError)
    rmSync(pendingPath)
    const pending = prepareVaultEnrollment(root)
    const manifest = createVaultManifest(key, newVaultIdentity(), randomUUID(), 'c3ludGhldGlj')
    writeVaultFile(root, 'vault-manifest.json', JSON.stringify(manifest))
    assert.throws(() => {
      finishVaultEnrollment(root)
    }, VaultError)
    assert.deepEqual(readVaultEnrollment(root), pending)
  } finally {
    key.fill(0)
    rmSync(root, { recursive: true, force: true })
  }
})
