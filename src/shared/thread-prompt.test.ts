import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SubthreadPromptHeldError, isSubthreadPromptHeldError } from './thread-prompt.ts'

test('recognises a held delegated prompt in-process and after Electron flattens it', () => {
  assert.equal(isSubthreadPromptHeldError(new SubthreadPromptHeldError('child')), true)
  // ipcRenderer.invoke rejects with `Error invoking remote method '<channel>': ${String(err)}`.
  const crossed = new Error(
    `Error invoking remote method 'agent:run': ${String(new SubthreadPromptHeldError('child'))}`,
  )
  assert.equal(isSubthreadPromptHeldError(crossed), true)
})

test('does not mistake other run failures for a held prompt', () => {
  assert.equal(isSubthreadPromptHeldError(new Error('network down')), false)
  assert.equal(isSubthreadPromptHeldError(new Error('The delegated prompt is held')), false)
  assert.equal(isSubthreadPromptHeldError(undefined), false)
})
