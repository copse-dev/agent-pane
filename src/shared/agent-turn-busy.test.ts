import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentTurnBusyError, isAgentTurnBusyError } from './agent-turn-busy.ts'

test('recognises the busy error in-process', () => {
  assert.equal(isAgentTurnBusyError(new AgentTurnBusyError('thread-1')), true)
})

test('recognises the busy error after Electron flattens it into an invoke rejection', () => {
  // ipcRenderer.invoke rejects with `Error invoking remote method '<channel>': ${String(err)}`.
  const crossed = new Error(
    `Error invoking remote method 'agent:run': ${String(new AgentTurnBusyError('thread-1'))}`,
  )
  assert.equal(isAgentTurnBusyError(crossed), true)
})

test('does not match other failures, including ones that merely mention a running turn', () => {
  assert.equal(isAgentTurnBusyError(new Error('network down')), false)
  assert.equal(
    isAgentTurnBusyError(new Error('An agent turn is already running for thread "x"')),
    false,
  )
  assert.equal(isAgentTurnBusyError(undefined), false)
})
