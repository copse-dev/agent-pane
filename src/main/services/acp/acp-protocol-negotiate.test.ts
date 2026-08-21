import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PROTOCOL_VERSION,
  EXPERIMENTAL_PROTOCOL_VERSION,
  initializeParams,
  negotiateProtocol,
  negotiatedVersion,
  selectProtocol,
} from './acp-protocol-negotiate.ts'

const INFO = { name: 'copse', version: '0.0.0' }

describe('initializeParams', () => {
  it('sends the v1 shape for v1 and the regrouped v2 shape for v2', () => {
    assert.deepEqual(initializeParams(1, INFO), {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    })
    // `info` is required in v2 and has no v1 counterpart; omitting it is a
    // `-32602 invalid initialize params` from a real agent.
    assert.deepEqual(initializeParams(2, INFO), {
      protocolVersion: 2,
      info: INFO,
      capabilities: {},
    })
  })
})

describe('negotiatedVersion', () => {
  it('reads the version out of either version-shaped response', () => {
    assert.equal(negotiatedVersion({ protocolVersion: 1, agentCapabilities: {} }), 1)
    assert.equal(negotiatedVersion({ protocolVersion: 2, info: INFO, capabilities: {} }), 2)
  })

  it('refuses a protocol this build cannot drive', () => {
    // A newer agent must not be mistaken for one we can speak: reading v3 as
    // "some kind of v2" is how a client ships a silent protocol mismatch.
    assert.equal(negotiatedVersion({ protocolVersion: 3 }), null)
    assert.equal(negotiatedVersion({ protocolVersion: '2' }), null)
    assert.equal(negotiatedVersion({}), null)
    assert.equal(negotiatedVersion(null), null)
    assert.equal(negotiatedVersion('nope'), null)
  })
})

describe('selectProtocol', () => {
  it('takes v2 when the agent answers v2', () => {
    const outcome = selectProtocol(2, { protocolVersion: 2, info: INFO, capabilities: {} })
    assert.deepEqual(outcome, { requested: 2, answered: 2, selected: 2, downgraded: false })
  })

  it('records the downgrade when a v1-only agent answers a v2 request', () => {
    // This is the case that matters: the PROTOCOL downgrades correctly, and it
    // is only the SDK's v2 client wrapper that cannot cope — so the decision
    // has to be made here, before that client is constructed.
    const outcome = selectProtocol(2, { protocolVersion: 1, agentCapabilities: {} })
    assert.deepEqual(outcome, { requested: 2, answered: 1, selected: 1, downgraded: true })
  })

  it('falls back to the shipping version on an answer it cannot drive', () => {
    const outcome = selectProtocol(2, { protocolVersion: 99 })
    assert.equal(outcome.answered, null)
    assert.equal(outcome.selected, DEFAULT_PROTOCOL_VERSION)
    // Not a downgrade: we did not learn a version, so there is nothing to
    // report as older — only a fallback.
    assert.equal(outcome.downgraded, false)
  })
})

describe('negotiateProtocol', () => {
  it('asks with the preferred version and reports what came back', async () => {
    const sent: Record<string, unknown>[] = []
    const outcome = await negotiateProtocol(
      async (params) => {
        sent.push(params)
        return { protocolVersion: 1, agentCapabilities: { loadSession: false } }
      },
      EXPERIMENTAL_PROTOCOL_VERSION,
      INFO,
    )

    assert.deepEqual(sent, [{ protocolVersion: 2, info: INFO, capabilities: {} }])
    assert.equal(outcome.selected, 1)
    assert.ok(outcome.downgraded)
  })
})

describe('the version constants', () => {
  it('track the two entry points the SDK actually publishes', () => {
    assert.equal(DEFAULT_PROTOCOL_VERSION, 1)
    assert.equal(EXPERIMENTAL_PROTOCOL_VERSION, 2)
  })
})
