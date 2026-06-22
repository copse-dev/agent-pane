import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRegistry } from '../services/registry-bootstrap.ts'
import { SANDBOX_TOOLS } from '../services/permission-policy.ts'

describe('web tools registration', () => {
  it('registers web_search and fetch_url as built-in tools', () => {
    const registry = createRegistry()
    assert.equal(registry.has('web_search'), true)
    assert.equal(registry.has('fetch_url'), true)
  })

  it('auto-runs web tools as read-only built-ins', () => {
    assert.equal(SANDBOX_TOOLS.has('web_search'), true)
    assert.equal(SANDBOX_TOOLS.has('fetch_url'), true)
  })
})
