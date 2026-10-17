import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  statSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireVaultMaintenance,
  registerVaultProfileClient,
  retireVaultMaintenance,
} from './profile-vault-access.ts'

describe('vault profile ownership', () => {
  it(
    'retires a stale process instance even when its PID belongs to a live process',
    {
      skip: process.platform !== 'linux' && process.platform !== 'darwin',
    },
    () => {
      const path = mkdtempSync(join(tmpdir(), 'copse-vault-access-'))
      try {
        const release = registerVaultProfileClient(path)
        const clients = join(path, '.vault-clients')
        const name = readdirSync(clients)[0]
        assert.ok(name)
        const lease = join(clients, name)
        const identity = readFileSync(lease, 'utf8')
        assert.notEqual(identity, '')
        assert.throws(() => acquireVaultMaintenance(path), /Close headless/)
        // Model a prior owner of this still-live PID. No age threshold is involved.
        writeFileSync(
          lease,
          process.platform === 'linux'
            ? 'linux:00000000-0000-0000-0000-000000000000:0'
            : 'darwin:Thu Jan  1 00:00:00 1970',
        )
        const maintenance = acquireVaultMaintenance(path)
        assert.deepEqual(readdirSync(clients), [])
        assert.throws(() => registerVaultProfileClient(path), /locked/)
        maintenance()
        release()
        registerVaultProfileClient(path)()
      } finally {
        rmSync(path, { recursive: true, force: true })
      }
    },
  )

  it('keeps unverifiable legacy and corrupt leases fail-closed', () => {
    const path = mkdtempSync(join(tmpdir(), 'copse-vault-access-'))
    try {
      const release = registerVaultProfileClient(path)
      const clients = join(path, '.vault-clients')
      const name = readdirSync(clients)[0]
      assert.ok(name)
      const lease = join(clients, name)
      writeFileSync(lease, '')
      assert.throws(() => acquireVaultMaintenance(path), /Close headless/)
      assert.equal(readFileSync(lease, 'utf8'), '')
      writeFileSync(lease, 'not a process birth identity')
      assert.throws(() => acquireVaultMaintenance(path), /corrupt/)
      assert.equal(readFileSync(lease, 'utf8'), 'not a process birth identity')
      release()
      acquireVaultMaintenance(path)()
    } finally {
      rmSync(path, { recursive: true, force: true })
    }
  })
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
