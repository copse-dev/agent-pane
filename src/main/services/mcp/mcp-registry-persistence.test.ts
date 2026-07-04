import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { isMcpToolRemembered, rememberMcpTool, setMcpServerUserEnabled } from './mcp-registry.ts'
import { storageGet, storageSet } from '../storage/storage.ts'

// These exercise the serialized read-modify-write path for the shared
// electron-store keys. `storage.ts` is replaced by the in-memory test shim,
// which routes writes through the same write-queue used in production.

const GRANTS_KEY = 'mcp-remembered-grants'
const DISABLED_KEY = 'mcpDisabledServers'

describe('mcp-registry persistence (serialized + validated)', () => {
  beforeEach(() => {
    storageSet(GRANTS_KEY, [])
    storageSet(DISABLED_KEY, [])
  })

  it('concurrent rememberMcpTool calls do not drop grants', async () => {
    await Promise.all([
      rememberMcpTool('mcp__a__tool'),
      rememberMcpTool('mcp__b__tool'),
      rememberMcpTool('mcp__c__tool'),
    ])
    const stored = storageGet(GRANTS_KEY) as string[]
    assert.deepEqual([...stored].sort(), ['mcp__a__tool', 'mcp__b__tool', 'mcp__c__tool'])
  })

  it('rememberMcpTool is idempotent under concurrency', async () => {
    await Promise.all([rememberMcpTool('dup'), rememberMcpTool('dup'), rememberMcpTool('dup')])
    assert.deepEqual(storageGet(GRANTS_KEY), ['dup'])
    assert.equal(isMcpToolRemembered('dup'), true)
  })

  it('isMcpToolRemembered ignores a corrupt (non-array) stored value', () => {
    storageSet(GRANTS_KEY, 'corrupt-not-an-array')
    assert.equal(isMcpToolRemembered('anything'), false)
  })

  it('rememberMcpTool recovers from a corrupt stored value', async () => {
    storageSet(GRANTS_KEY, { not: 'a list' })
    await rememberMcpTool('fresh')
    assert.deepEqual(storageGet(GRANTS_KEY), ['fresh'])
  })

  it('concurrent setMcpServerUserEnabled toggles do not drop updates', async () => {
    // Disable three servers concurrently; all three must persist.
    await Promise.all([
      setMcpServerUserEnabled('s1', false),
      setMcpServerUserEnabled('s2', false),
      setMcpServerUserEnabled('s3', false),
    ])
    assert.deepEqual(storageGet(DISABLED_KEY), ['s1', 's2', 's3'])

    // Re-enabling one removes only that one.
    await setMcpServerUserEnabled('s2', true)
    assert.deepEqual(storageGet(DISABLED_KEY), ['s1', 's3'])
  })

  it('setMcpServerUserEnabled tolerates a corrupt stored value', async () => {
    storageSet(DISABLED_KEY, 42)
    await setMcpServerUserEnabled('only', false)
    assert.deepEqual(storageGet(DISABLED_KEY), ['only'])
  })
})
