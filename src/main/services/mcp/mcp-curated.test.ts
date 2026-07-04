import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  CURATED_MCP_SERVERS,
  CURATED_MCP_SOURCE,
  getCuratedServerStatuses,
  getEnabledCuratedConfigs,
  getEnabledCuratedServerNames,
  setCuratedServerEnabled,
} from './mcp-curated.ts'
import { storageGet, storageSet } from '../storage.ts'
import type { McpServerStatus } from '@shared/types/mcp.ts'

const ENABLED_KEY = 'mcpEnabledCuratedServers'
const firstCuratedServer = CURATED_MCP_SERVERS[0]
if (!firstCuratedServer) throw new Error('CURATED_MCP_SERVERS is empty')
const SAMPLE = firstCuratedServer.name

describe('curated MCP catalog', () => {
  beforeEach(() => {
    storageSet(ENABLED_KEY, [])
  })

  it('ships the MDN server in the catalog', () => {
    const mdn = CURATED_MCP_SERVERS.find((s) => s.name === 'mdn')
    assert.ok(mdn, 'MDN entry should exist')
    assert.equal(mdn.transport, 'http')
    assert.equal(mdn.url, 'https://mcp.mdn.mozilla.net/')
  })

  it('sends the Mozilla analytics opt-out header for MDN by default', () => {
    const mdn = CURATED_MCP_SERVERS.find((s) => s.name === 'mdn')
    assert.ok(mdn, 'MDN entry should exist')
    assert.equal(mdn.headers?.['X-Moz-1st-Party-Data-Opt-Out'], '1')
  })

  it('propagates curated headers into the built config', async () => {
    await setCuratedServerEnabled('mdn', true)
    const config = getEnabledCuratedConfigs().find((c) => c.name === 'mdn')
    assert.ok(config, 'enabled MDN config should exist')
    assert.equal(config.headers?.['X-Moz-1st-Party-Data-Opt-Out'], '1')
  })

  it('curated servers are off by default', () => {
    assert.equal(getEnabledCuratedServerNames().size, 0)
    assert.deepEqual(getEnabledCuratedConfigs(), [])
    const statuses = getCuratedServerStatuses([])
    assert.ok(statuses.every((s) => !s.enabled && s.state === 'disabled'))
  })

  it('enabling a server persists and produces a config with the curated source', async () => {
    await setCuratedServerEnabled(SAMPLE, true)
    assert.deepEqual(storageGet(ENABLED_KEY), [SAMPLE])

    const configs = getEnabledCuratedConfigs()
    assert.equal(configs.length, 1)
    const [firstConfig] = configs
    assert.ok(firstConfig, 'expected one enabled config')
    assert.equal(firstConfig.name, SAMPLE)
    assert.equal(firstConfig.source, CURATED_MCP_SOURCE)
  })

  it('disabling removes only that server', async () => {
    await setCuratedServerEnabled(SAMPLE, true)
    await setCuratedServerEnabled(SAMPLE, false)
    assert.deepEqual(storageGet(ENABLED_KEY), [])
    assert.deepEqual(getEnabledCuratedConfigs(), [])
  })

  it('toggling an unknown server is a no-op', async () => {
    await setCuratedServerEnabled('does-not-exist', true)
    assert.deepEqual(storageGet(ENABLED_KEY), [])
  })

  it('ignores stored names no longer in the catalog', () => {
    storageSet(ENABLED_KEY, ['ghost-server', SAMPLE])
    assert.deepEqual([...getEnabledCuratedServerNames()], [SAMPLE])
  })

  it('tolerates a corrupt stored value', async () => {
    storageSet(ENABLED_KEY, 42)
    await setCuratedServerEnabled(SAMPLE, true)
    assert.deepEqual(storageGet(ENABLED_KEY), [SAMPLE])
  })

  it('joins live connection state for enabled servers', async () => {
    await setCuratedServerEnabled(SAMPLE, true)
    const live: McpServerStatus[] = [
      {
        name: SAMPLE,
        transport: 'http',
        state: 'connected',
        toolCount: 3,
        tools: ['search', 'doc', 'compat'],
        userEnabled: true,
        configDisabled: false,
        curated: true,
      },
    ]
    const status = getCuratedServerStatuses(live).find((s) => s.name === SAMPLE)
    assert.ok(status, 'expected status for sample server')
    assert.equal(status.enabled, true)
    assert.equal(status.state, 'connected')
    assert.equal(status.toolCount, 3)
    assert.deepEqual(status.tools, ['search', 'doc', 'compat'])
  })

  it('reports connecting when enabled but no live status yet', async () => {
    await setCuratedServerEnabled(SAMPLE, true)
    const status = getCuratedServerStatuses([]).find((s) => s.name === SAMPLE)
    assert.ok(status, 'expected status for sample server')
    assert.equal(status.state, 'connecting')
  })
})
