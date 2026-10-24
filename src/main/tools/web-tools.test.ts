import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRegistry } from '../services/registry-bootstrap.ts'
import { SANDBOX_TOOLS } from '../services/security/permission-policy.ts'
import { setSetting, setApiKey, deleteApiKey } from '../services/storage/settings.test-shim.ts'

describe('web tools registration', () => {
  afterEach(() => {
    setSetting('webSearchProvider', 'none')
    deleteApiKey('tavily')
  })

  it('keeps URL fetching available without offering an unconfigured search tool', () => {
    setSetting('webSearchProvider', 'none')
    const registry = createRegistry()
    assert.equal(registry.has('web_search'), false)
    assert.equal(registry.has('fetch_url'), true)
  })

  it('offers both tools when the selected search provider has a key', () => {
    setSetting('webSearchProvider', 'tavily')
    setApiKey('tavily', 'tavily-fixture')
    const names = createRegistry()
      .toLLMTools()
      .map((tool) => tool.name)
    assert.equal(names.includes('web_search'), true)
    assert.equal(names.includes('fetch_url'), true)
  })

  it('keeps web tools behind the origin permission gate', () => {
    assert.equal(SANDBOX_TOOLS.has('web_search'), false)
    assert.equal(SANDBOX_TOOLS.has('fetch_url'), false)
  })
})
