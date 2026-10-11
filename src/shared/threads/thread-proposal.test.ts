import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolCall } from '@shared/types'
import { isThreadProposalCall } from './thread-proposal.ts'

const call: ToolCall = {
  id: 'proposal-1',
  name: 'propose_thread',
  status: 'done',
  args: {},
  result: null,
}

test('ACP bridge names resolve to the same proposal, unrelated calls do not', () => {
  assert.ok(isThreadProposalCall(call))
  assert.ok(isThreadProposalCall({ ...call, name: 'mcp__copse__propose_thread' }))
  assert.ok(isThreadProposalCall({ ...call, name: 'copse.propose_thread' }))
  assert.ok(
    isThreadProposalCall({
      ...call,
      name: 'read_file',
      programmaticName: 'mcp__copse__propose_thread',
    }),
  )
  assert.equal(isThreadProposalCall({ ...call, name: 'request_review_input' }), false)
  assert.equal(isThreadProposalCall({ ...call, name: 'mcp__copse__propose_thread_extra' }), false)
})
