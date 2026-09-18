import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isMcpToolRemembered, rememberMcpTool, setMcpServerUserEnabled } from './mcp-registry.ts'
import { getSetting, setSetting } from '../storage/settings.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import { expectStringArray } from '@shared/unknown-value.ts'
import {
  clearMcpToolPermissionTargets,
  registerMcpToolPermissionTarget,
} from '../security/tool-permissions.ts'
import { mcpToolName } from './mcp-config.ts'

// These exercise serialized read-modify-write paths. The storage modules are
// replaced by in-memory test shims that use the same write queue as production.

const OVERRIDES_KEY = 'toolPermissionOverrides'
const DISABLED_KEY = 'mcpDisabledServers'

function registerTool(serverName: string, toolName: string): { executionName: string; id: string } {
  const id = registerMcpToolPermissionTarget({
    serverName,
    toolName,
    origin: 'user',
    source: '/user/mcp.json',
  })
  return { executionName: mcpToolName(serverName, toolName), id }
}

describe('mcp-registry persistence (serialized + validated)', () => {
  beforeEach(async () => {
    clearMcpToolPermissionTargets()
    await setSetting(OVERRIDES_KEY, {})
    storageSet(DISABLED_KEY, [])
  })

  it('concurrent rememberMcpTool calls do not drop grants', async () => {
    const tools = [registerTool('a', 'tool'), registerTool('b', 'tool'), registerTool('c', 'tool')]

    await Promise.all(tools.map(({ executionName }) => rememberMcpTool(executionName)))

    assert.deepEqual(getSetting(OVERRIDES_KEY, {}), {
      [tools[0]?.id ?? '']: 'allow',
      [tools[1]?.id ?? '']: 'allow',
      [tools[2]?.id ?? '']: 'allow',
    })
  })

  it('rememberMcpTool is idempotent under concurrency', async () => {
    const tool = registerTool('server', 'duplicate')

    await Promise.all([
      rememberMcpTool(tool.executionName),
      rememberMcpTool(tool.executionName),
      rememberMcpTool(tool.executionName),
    ])

    assert.deepEqual(getSetting(OVERRIDES_KEY, {}), { [tool.id]: 'allow' })
    assert.equal(isMcpToolRemembered(tool.executionName), true)
  })

  it('ignores a corrupt override value on read', async () => {
    const tool = registerTool('server', 'tool')
    await setSetting(OVERRIDES_KEY, 'corrupt-not-an-object')

    assert.equal(isMcpToolRemembered(tool.executionName), false)
  })

  it('does not remember an unregistered or ambiguous execution identity', async () => {
    await rememberMcpTool('mcp__missing__tool')
    assert.deepEqual(getSetting(OVERRIDES_KEY, {}), {})
  })

  it('concurrent setMcpServerUserEnabled toggles do not drop updates', async () => {
    await Promise.all([
      setMcpServerUserEnabled('s1', false),
      setMcpServerUserEnabled('s2', false),
      setMcpServerUserEnabled('s3', false),
    ])
    assert.deepEqual(storageGet(DISABLED_KEY), ['s1', 's2', 's3'])

    await setMcpServerUserEnabled('s2', true)
    assert.deepEqual(storageGet(DISABLED_KEY), ['s1', 's3'])
  })

  it('setMcpServerUserEnabled tolerates a corrupt stored value', async () => {
    storageSet(DISABLED_KEY, 42)
    await setMcpServerUserEnabled('only', false)
    assert.deepEqual(expectStringArray(storageGet(DISABLED_KEY)), ['only'])
  })
})
