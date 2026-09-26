import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mcpErrorMessage } from './tool-error-format.ts'

describe('mcpErrorMessage', () => {
  it('extracts the readable message from a simple denied MCP envelope', () => {
    const message =
      'This action was rejected due to unacceptable risk.\nReason: The advisor receives the full transcript and verified repository state.'
    assert.equal(mcpErrorMessage(JSON.stringify({ result: null, error: { message } })), message)
  })

  it('leaves richer or unrelated JSON untouched', () => {
    assert.equal(mcpErrorMessage(JSON.stringify({ result: { count: 2 }, error: null })), null)
    assert.equal(
      mcpErrorMessage(JSON.stringify({ result: null, error: { message: 'Denied', code: 403 } })),
      null,
    )
    assert.equal(mcpErrorMessage('Error: ENOENT'), null)
  })
})
