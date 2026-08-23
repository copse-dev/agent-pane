import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRegistry } from '../services/registry-bootstrap.ts'
import { setSetting } from '../services/storage/settings.ts'
import { SANDBOX_TOOLS } from '../services/security/permission-policy.ts'
import {
  BROWSER_TOOLS,
  READ_ONLY_BROWSER_TOOLS,
} from '../services/browser/browser-origin-policy.ts'
import { browserShowTool } from './browser-tools.ts'
import { setBrowserSessionPlatform } from '../services/browser/session-manager.ts'

describe('browser tools registration', () => {
  afterEach(async () => {
    // Restore the on-by-default state for other suites.
    await setSetting('browserToolsEnabled', true)
  })

  it('registers all browser tools by default (enabled)', async () => {
    await setSetting('browserToolsEnabled', true)
    const registry = createRegistry()
    for (const name of BROWSER_TOOLS) {
      assert.equal(registry.has(name), true, `expected ${name} to be registered`)
    }
  })

  it('omits browser tools when explicitly disabled', async () => {
    await setSetting('browserToolsEnabled', false)
    const registry = createRegistry()
    assert.equal(registry.has('browser_navigate'), false)
    assert.equal(registry.has('browser_snapshot'), false)
  })

  it('keeps browser tools out of the always-auto-run set', () => {
    // Navigation is origin-gated, so it must not be in SANDBOX_TOOLS.
    assert.equal(SANDBOX_TOOLS.has('browser_navigate'), false)
  })

  it('treats browser_show as read-only: it cannot reach a new origin', () => {
    // It only promotes a canvas artefact, or a page already open in this
    // session, so there is nothing for an origin prompt to decide. The
    // already-open check in the tool is what makes that claim true.
    assert.equal(BROWSER_TOOLS.has('browser_show'), true)
    assert.equal(READ_ONLY_BROWSER_TOOLS.has('browser_show'), true)
  })
})

describe('browser_show', () => {
  const signal = new AbortController().signal

  afterEach(() => {
    setBrowserSessionPlatform(null)
  })

  it('refuses a url that is not open in the agent browser', () => {
    // Otherwise this becomes an unprompted way to point the user's visible
    // browser at any origin, bypassing the gate on browser_navigate.
    assert.throws(
      () => browserShowTool.execute({ url: 'https://example.com/', title: undefined }, signal),
      /not open in the agent browser/,
    )
  })

  it('rejects being given both a title and a url', () => {
    assert.throws(
      () =>
        browserShowTool.execute({ title: 'Sales Dashboard', url: 'https://example.com/' }, signal),
      /not both/,
    )
  })

  it('requires one of them', () => {
    assert.throws(
      () => browserShowTool.execute({ title: undefined, url: undefined }, signal),
      /Pass a title/,
    )
  })

  it('promotes a canvas artefact by title', () => {
    const shown: Array<{ title: string; threadId?: string }> = []
    setBrowserSessionPlatform({
      createWindow: () => {
        throw new Error('not used')
      },
      getAgentSession: () => {
        throw new Error('not used')
      },
      showUrl: () => {
        throw new Error('not used')
      },
      showArtefact: (identity) => shown.push(identity),
    })

    const out = browserShowTool.execute({ title: 'Sales Dashboard', url: undefined }, signal)

    assert.deepEqual(shown, [{ title: 'Sales Dashboard' }])
    assert.ok(typeof out === 'string')
    assert.match(out, /Sales Dashboard/)
  })
})
