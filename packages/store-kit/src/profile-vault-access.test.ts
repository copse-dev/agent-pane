import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireVaultMaintenance,
  registerVaultProfileClient,
  retireVaultMaintenance,
} from './profile-vault-access.ts'

describe('vault profile ownership', () => {
  it(
    'rejects an existing client directory accessible by other users',
    {
      skip: process.platform === 'win32',
    },
    () => {
      const path = mkdtempSync(join(tmpdir(), 'copse-vault-access-'))
      try {
        const clients = join(path, '.vault-clients')
        mkdirSync(clients)
        chmodSync(clients, 0o777)
        assert.throws(() => registerVaultProfileClient(path), /corrupt/)
        assert.throws(() => acquireVaultMaintenance(path), /corrupt/)
        assert.equal(statSync(clients).mode & 0o777, 0o777)
        chmodSync(clients, 0o700)
        const release = registerVaultProfileClient(path)
        assert.throws(() => acquireVaultMaintenance(path), /Close headless/)
        release()
        acquireVaultMaintenance(path)()
      } finally {
        rmSync(path, { recursive: true, force: true })
      }
    },
  )
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
  it('tolerates releasing a gate that is already gone', () => {
    const path = mkdtempSync(join(tmpdir(), 'copse-vault-access-'))
    try {
      const release = acquireVaultMaintenance(path)
      retireVaultMaintenance(path)
      release()
      release()
      retireVaultMaintenance(path)
      acquireVaultMaintenance(path)()
    } finally {
      rmSync(path, { recursive: true, force: true })
    }
  })
})
