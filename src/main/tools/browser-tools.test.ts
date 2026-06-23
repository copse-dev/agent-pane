import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRegistry } from '../services/registry-bootstrap.ts'
import { setSetting } from '../services/settings.ts'
import { SANDBOX_TOOLS } from '../services/permission-policy.ts'
import { BROWSER_TOOLS } from '../services/browser/browser-origin-policy.ts'

describe('browser tools registration', () => {
  afterEach(async () => {
    await setSetting('browserToolsEnabled', false)
  })

  it('does not register browser tools by default', () => {
    const registry = createRegistry()
    assert.equal(registry.has('browser_navigate'), false)
    assert.equal(registry.has('browser_snapshot'), false)
  })

  it('registers all browser tools when the setting is enabled', async () => {
    await setSetting('browserToolsEnabled', true)
    const registry = createRegistry()
    for (const name of BROWSER_TOOLS) {
      assert.equal(registry.has(name), true, `expected ${name} to be registered`)
    }
  })

  it('keeps browser tools out of the always-auto-run set', () => {
    // Navigation is origin-gated, so it must not be in SANDBOX_TOOLS.
    assert.equal(SANDBOX_TOOLS.has('browser_navigate'), false)
  })
})
