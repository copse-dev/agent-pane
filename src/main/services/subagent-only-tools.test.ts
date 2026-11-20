import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SUBAGENT_ONLY_TOOLS } from './subagent-only-tools.ts'
import { SUBAGENT_ALLOWED_TOOL_NAMES } from '@copse/agent/run-subagent.ts'

describe('SUBAGENT_ONLY_TOOLS', () => {
  it('offers read_explored only in explore mode, alongside explore (#1433 Fix 0b)', () => {
    assert.equal(SUBAGENT_ONLY_TOOLS.has('explore'), true)
    assert.equal(SUBAGENT_ONLY_TOOLS.has('read_explored'), true)
  })

  it('never hands a subagent-only tool to the explore subagent itself', () => {
    for (const name of SUBAGENT_ONLY_TOOLS) {
      assert.equal(
        SUBAGENT_ALLOWED_TOOL_NAMES.some((allowed) => allowed === name),
        false,
        name,
      )
    }
  })
})
