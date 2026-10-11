import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCopseToolCall } from './copse-tool-call.ts'

test('matches the bare name and every ACP-bridged wrapping of it', () => {
  assert.ok(isCopseToolCall({ name: 'propose_thread' }, 'propose_thread'))
  assert.ok(isCopseToolCall({ name: 'mcp__copse__propose_thread' }, 'propose_thread'))
  assert.ok(isCopseToolCall({ name: 'copse.propose_thread' }, 'propose_thread'))
  assert.ok(isCopseToolCall({ name: 'copse-propose_thread: Migrate settings' }, 'propose_thread'))
  assert.ok(
    isCopseToolCall(
      { name: 'Propose thread', programmaticName: 'mcp__copse__propose_thread' },
      'propose_thread',
    ),
  )
})

test('does not match an unrelated or prefix-colliding tool', () => {
  assert.equal(isCopseToolCall({ name: 'request_review_input' }, 'propose_thread'), false)
  assert.equal(
    isCopseToolCall({ name: 'mcp__copse__propose_thread_extra' }, 'propose_thread'),
    false,
  )
  assert.equal(isCopseToolCall({ name: 'mcp__other__propose_thread' }, 'propose_thread'), false)
})
