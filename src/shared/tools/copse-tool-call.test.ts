import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  acpDelegateKind,
  acpDelegatePrompt,
  copseToolCallName,
  isAcpDelegateToolCall,
  isCopseToolCall,
  normalizeCopseToolName,
} from './copse-tool-call.ts'

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

test('isAcpDelegateToolCall matches a think-kind Agent/Task call with no session', () => {
  assert.ok(isAcpDelegateToolCall({ kind: 'think', name: 'Agent' }))
  assert.ok(isAcpDelegateToolCall({ kind: 'think', name: 'Task' }))
  assert.ok(isAcpDelegateToolCall({ kind: 'think', name: 'delegate', programmaticName: 'Agent' }))
})

test('isAcpDelegateToolCall rejects anything that is not an unattached think-kind Agent/Task call', () => {
  // Wrong kind.
  assert.equal(isAcpDelegateToolCall({ kind: 'execute', name: 'Agent' }), false)
  assert.equal(isAcpDelegateToolCall({ name: 'Agent' }), false)
  // Wrong name.
  assert.equal(isAcpDelegateToolCall({ kind: 'think', name: 'explore' }), false)
  // Copse's own native dispatch tool already carries a session — never double-count it.
  assert.equal(
    isAcpDelegateToolCall({
      kind: 'think',
      name: 'Agent',
      subagent: {
        id: 's1',
        kind: 'explore',
        status: 'running',
        prompt: 'p',
        summary: null,
        messages: [],
      },
    }),
    false,
  )
})

test('acpDelegateKind reads subagent_type verbatim, and acpDelegatePrompt prefers the live title', () => {
  assert.equal(acpDelegateKind({ args: { subagent_type: 'Explore' } }), 'Explore')
  assert.equal(acpDelegateKind({ args: {} }), null)
  assert.equal(acpDelegateKind({ args: undefined }), null)
  assert.equal(
    acpDelegatePrompt({
      title: 'Panel registration research',
      args: { prompt: 'Find the panel registry' },
    }),
    'Panel registration research',
  )
  assert.equal(
    acpDelegatePrompt({ args: { prompt: 'Find the panel registry' } }),
    'Find the panel registry',
  )
  assert.equal(
    acpDelegatePrompt({ args: { description: 'Local file-tree utilities' } }),
    'Local file-tree utilities',
  )
  assert.equal(acpDelegatePrompt({ args: {} }), '')
})
