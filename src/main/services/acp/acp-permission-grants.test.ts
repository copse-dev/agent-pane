import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { isAcpPermissionRemembered, rememberAcpPermission } from './acp-permission-grants.ts'
import { storageGet, storageSet } from '../storage.ts'

// Mirrors mcp-registry-persistence.test.ts: `storage.ts` is replaced by the
// in-memory test shim, which routes writes through the same write-queue used
// in production.

const GRANTS_KEY = 'acp-remembered-grants'

describe('acp-permission-grants', () => {
  beforeEach(() => {
    storageSet(GRANTS_KEY, [])
  })

  it('remembers a grant scoped to the (agent, kind) pair', async () => {
    await rememberAcpPermission('claude-agent-acp', 'execute')
    assert.equal(isAcpPermissionRemembered('claude-agent-acp', 'execute'), true)
    // Neither a different kind nor a different agent inherits the grant.
    assert.equal(isAcpPermissionRemembered('claude-agent-acp', 'edit'), false)
    assert.equal(isAcpPermissionRemembered('gemini-acp', 'execute'), false)
  })

  it('concurrent grants do not drop each other', async () => {
    await Promise.all([
      rememberAcpPermission('a', 'read'),
      rememberAcpPermission('a', 'execute'),
      rememberAcpPermission('b', 'read'),
    ])
    const stored = storageGet(GRANTS_KEY) as string[]
    assert.deepEqual([...stored].sort(), ['a:execute', 'a:read', 'b:read'])
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
