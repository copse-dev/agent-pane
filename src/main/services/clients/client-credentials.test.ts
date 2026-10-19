import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { ClientCredentials, type ClientCredential } from './client-credentials.ts'
import { clientLabelSchema } from '../../../shared/client-auth.ts'

describe('shared client credentials', () => {
  it('authenticates existing mobile hashes without changing identity or defaulting to control', () => {
    const token = 'ab'.repeat(32)
    const record = {
      id: randomUUID(),
      label: 'Existing phone',
      createdAt: 123,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      access: 'read',
    } satisfies ClientCredential
    const credentials = new ClientCredentials([record])
    assert.deepEqual(credentials.principal(`Bearer ${token}`), {
      id: record.id,
      label: record.label,
      access: 'read',
    })
    assert.equal(credentials.principal(`Bearer ${token}`, undefined, 'control'), null)
    assert.equal(credentials.principal(`Bearer ${token}`, 'http://127.0.0.1:17341'), null)
  })

  it('isolates stores and bindings and rechecks downgrade, revocation and session termination', () => {
    for (const binding of [undefined, 'http://127.0.0.1:17341']) {
      let saved: ClientCredential[] = []
      const credentials = new ClientCredentials([], (records) => {
        saved = records
      })
      const issued = credentials.issue('Review client', 'control', binding)
      const header = `Bearer ${issued.token}`
      assert.match(issued.token, /^[a-f0-9]{64}$/)
      assert.equal(JSON.stringify(saved).includes(issued.token), false)
      assert.equal(new ClientCredentials().principal(header, binding), null)
      assert.equal(credentials.principal(header, 'http://127.0.0.1:17342'), null)
      assert.equal(credentials.principal(header, binding, 'control')?.id, issued.id)
      assert.equal(new ClientCredentials(saved).principal(header, binding)?.id, issued.id)
      credentials.setAccess(issued.id, 'read')
      assert.equal(credentials.principal(header, binding)?.access, 'read')
      assert.equal(credentials.principal(header, binding, 'control'), null)
      credentials.revoke(issued.id)
      assert.equal(credentials.principal(header, binding), null)
      assert.equal(new ClientCredentials(saved).principal(header, binding), null)
      const next = credentials.issue('Next client')
      credentials.clear()
      assert.equal(credentials.principal(`Bearer ${next.token}`), null)
    }
  })

  it('rejects malformed credentials and keeps failed persisted grants out of memory', () => {
    let writes = 0
    const credentials = new ClientCredentials([], () => {
      if (++writes > 1) throw new Error('Disk unavailable')
    })
    const issued = credentials.issue('Phone')
    for (const header of [
      undefined,
      '',
      issued.token,
      `Basic ${issued.token}`,
      `bearer ${issued.token}`,
      `Bearer ${issued.token} `,
      `Bearer ${'a'.repeat(63)}`,
      `Bearer ${'x'.repeat(64)}`,
    ])
      assert.equal(credentials.principal(header), null)
    assert.throws(() => {
      credentials.setAccess(issued.id, 'control')
    }, /Disk unavailable/)
    assert.equal(credentials.principal(`Bearer ${issued.token}`)?.access, 'read')
    assert.throws(() => credentials.issue('Unsaved client', 'control'), /Disk unavailable/)
    assert.equal(credentials.list().length, 1)
    assert.throws(() => {
      credentials.revoke(issued.id)
    }, /Disk unavailable/)
    assert.equal(credentials.principal(`Bearer ${issued.token}`), null)
  })

  it('downgrades control in memory even when a durable restriction cannot be written', () => {
    let writable = true
    const credentials = new ClientCredentials([], () => {
      if (!writable) throw new Error('Disk unavailable')
    })
    const issued = credentials.issue('Phone', 'control')
    writable = false
    assert.throws(() => {
      credentials.setAccess(issued.id, 'read')
    }, /Disk unavailable/)
    assert.equal(credentials.principal(`Bearer ${issued.token}`)?.access, 'read')
    assert.equal(credentials.principal(`Bearer ${issued.token}`, undefined, 'control'), null)
    assert.throws(() => {
      credentials.clear()
    }, /Disk unavailable/)
    assert.equal(credentials.principal(`Bearer ${issued.token}`), null)
  })

  it('uses one label policy so neither pairing surface can inject control characters', () => {
    assert.equal(clientLabelSchema.parse('  My phone  '), 'My phone')
    for (const label of [
      '',
      ' ',
      'a'.repeat(65),
      'Phone\nCode: 123456',
      'Phone\u0000',
      'Phone\u007f',
    ])
      assert.equal(clientLabelSchema.safeParse(label).success, false)
  })
})
