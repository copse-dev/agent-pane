import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runWithAgentRunReadonly, isAgentRunReadonly } from './agent-run-readonly.ts'

describe('agent-run-readonly', () => {
  it('defaults to writable outside a run context', () => {
    assert.equal(isAgentRunReadonly(), false)
  })

  it('scopes the readonly flag to nested run contexts', async () => {
    await runWithAgentRunReadonly(true, async () => {
      assert.equal(isAgentRunReadonly(), true)
      await runWithAgentRunReadonly(false, async () => {
        assert.equal(isAgentRunReadonly(), false)
      })
      assert.equal(isAgentRunReadonly(), true)
    })
    assert.equal(isAgentRunReadonly(), false)
  })
})
