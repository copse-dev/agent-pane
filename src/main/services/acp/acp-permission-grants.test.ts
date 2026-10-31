import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  isAcpPermissionRemembered,
  rememberAcpPermission,
  type AcpGrantLocation,
} from './acp-permission-grants.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import { expectStringArray } from '@shared/unknown-value.ts'

// Mirrors mcp-registry-persistence.test.ts: `storage.ts` is replaced by the
// in-memory test shim, which routes writes through the same write-queue used
// in production.

const GRANTS_KEY = 'acp-remembered-grants'

describe('acp-permission-grants', () => {
  beforeEach(() => {
    storageSet(GRANTS_KEY, [])
  })

  it('remembers a grant scoped to the (agent, kind) pair', async () => {
    await rememberAcpPermission('claude-agent-acp', 'edit')
    assert.equal(isAcpPermissionRemembered('claude-agent-acp', 'edit'), true)
    // Neither a different kind nor a different agent inherits the grant.
    assert.equal(isAcpPermissionRemembered('claude-agent-acp', 'fetch'), false)
    assert.equal(isAcpPermissionRemembered('gemini-acp', 'edit'), false)
  })

  it('keeps local grants and the grants of each SSH host apart', async () => {
    const dev: AcpGrantLocation = { kind: 'remote', hostId: 'dev' }
    const prod: AcpGrantLocation = { kind: 'remote', hostId: 'prod' }
    await rememberAcpPermission('a', 'fetch')
    assert.equal(isAcpPermissionRemembered('a', 'fetch', dev), false)

    await rememberAcpPermission('b', 'edit', dev)
    assert.equal(isAcpPermissionRemembered('b', 'edit', dev), true)
    assert.equal(isAcpPermissionRemembered('b', 'edit', prod), false, 'another host asks again')
    assert.equal(isAcpPermissionRemembered('b', 'edit'), false)
    // Local keys keep their original form, so grants stored before this change hold.
    assert.deepEqual([...expectStringArray(storageGet(GRANTS_KEY))].sort(), [
      'a:fetch',
      'b@remote/dev:edit',
    ])
  })

  it('does not reuse a legacy host-agnostic remote grant', () => {
    storageSet(GRANTS_KEY, ['a@remote:read'])
    assert.equal(isAcpPermissionRemembered('a', 'read', { kind: 'remote', hostId: 'dev' }), false)
  })

  it('concurrent grants do not drop each other', async () => {
    await Promise.all([
      rememberAcpPermission('a', 'read'),
      rememberAcpPermission('a', 'edit'),
      rememberAcpPermission('b', 'read'),
    ])
    const stored = expectStringArray(storageGet(GRANTS_KEY))
    assert.deepEqual([...stored].sort(), ['a:edit', 'a:read', 'b:read'])
  })

  it('never stores an execute grant', async () => {
    await rememberAcpPermission('a', 'execute')
    await rememberAcpPermission('a', 'execute', { kind: 'remote', hostId: 'dev' })
    assert.deepEqual(storageGet(GRANTS_KEY), [])
  })

  it('ignores execute grants stored by earlier versions and prunes them on write', async () => {
    const dev: AcpGrantLocation = { kind: 'remote', hostId: 'dev' }
    storageSet(GRANTS_KEY, ['a:execute', 'a@remote/dev:execute', 'a:read'])
    assert.equal(isAcpPermissionRemembered('a', 'execute'), false)
    assert.equal(isAcpPermissionRemembered('a', 'execute', dev), false)
    assert.equal(isAcpPermissionRemembered('a', 'read'), true, 'other kinds still hold')

    await rememberAcpPermission('b', 'edit')
    assert.deepEqual(storageGet(GRANTS_KEY), ['a:read', 'b:edit'])
  })

  it('is idempotent under concurrency', async () => {
    await Promise.all([
      rememberAcpPermission('a', 'read'),
      rememberAcpPermission('a', 'read'),
      rememberAcpPermission('a', 'read'),
    ])
    assert.deepEqual(storageGet(GRANTS_KEY), ['a:read'])
  })

  it('ignores a corrupt (non-array) stored value on read', () => {
    storageSet(GRANTS_KEY, 'corrupt-not-an-array')
    assert.equal(isAcpPermissionRemembered('a', 'read'), false)
  })

  it('recovers from a corrupt stored value on write', async () => {
    storageSet(GRANTS_KEY, { not: 'a list' })
    await rememberAcpPermission('a', 'read')
    assert.deepEqual(storageGet(GRANTS_KEY), ['a:read'])
  })
})
