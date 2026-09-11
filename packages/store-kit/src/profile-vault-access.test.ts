import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireVaultMaintenance,
  registerVaultProfileClient,
  retireVaultMaintenance,
} from './profile-vault-access.ts'

describe('vault profile ownership', () => {
  it('prevents migration beside existing clients and new clients during migration', () => {
    const path = mkdtempSync(join(tmpdir(), 'copse-vault-access-'))
    try {
      const first = registerVaultProfileClient(path)
      const second = registerVaultProfileClient(path)
      assert.throws(() => acquireVaultMaintenance(path), /Close headless/)
      first()
      assert.throws(() => acquireVaultMaintenance(path), /Close headless/)
      second()
      const release = acquireVaultMaintenance(path)
      assert.throws(() => registerVaultProfileClient(path), /locked/)
      release()
      registerVaultProfileClient(path)()
    } finally {
      rmSync(path, { recursive: true, force: true })
    }
  })
  it('lets a new desktop owner retire a crashed empty maintenance gate', () => {
    const path = mkdtempSync(join(tmpdir(), 'copse-vault-access-'))
    try {
      mkdirSync(join(path, '.vault-maintenance'))
      retireVaultMaintenance(path)
      acquireVaultMaintenance(path)()
    } finally {
      rmSync(path, { recursive: true, force: true })
    }
  })
})
