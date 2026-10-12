import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copseToolCallName, isCopseToolCall, normalizeCopseToolName } from './copse-tool-call.ts'

test('normalizes Copse wrappers while preserving other servers and human titles', () => {
  for (const name of [
    'run_shell',
    'mcp__copse__run_shell',
    'mcp.copse.run_shell',
    'copse.run_shell',
    'copse-run_shell: Run tests',
    'MCP__COPSE__RUN_SHELL',
  ]) {
    assert.equal(normalizeCopseToolName(name), 'run_shell')
  }
  for (const name of ['mcp__other__run_shell', 'mcp__copse.git__status', 'Run copse.run_shell']) {
    assert.equal(normalizeCopseToolName(name), name)
  }
  assert.equal(normalizeCopseToolName('mcp.copse.custom.tool'), 'custom.tool')
  assert.equal(
    copseToolCallName({ name: 'Run tests', programmaticName: 'copse.run_shell' }),
    'run_shell',
  )
  assert.equal(copseToolCallName({ name: 'mcp__other__run_shell' }), 'mcp__other__run_shell')
})

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
