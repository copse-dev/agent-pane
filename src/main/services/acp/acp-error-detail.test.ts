import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { acpErrorMessage } from './acp-error-detail.ts'

describe('acpErrorMessage', () => {
  it('includes JSON-RPC error.data.details when present', () => {
    const err = new Error('Internal error')
    Object.defineProperty(err, 'data', {
      value: {
        details: "Claude Code process exited with code 1. stderr: error: unknown option '--tools'",
      },
    })

    assert.equal(
      acpErrorMessage(err),
      "Internal error: Claude Code process exited with code 1. stderr: error: unknown option '--tools'",
    )
  })

  it('falls back to the base message when there is no structured detail', () => {
    assert.equal(acpErrorMessage(new Error('ACP connection closed')), 'ACP connection closed')
  })

  it('finds the detail through the cause chain and truncates long data', () => {
    const rpc = new Error('Internal error')
    Object.defineProperty(rpc, 'data', { value: 'x'.repeat(2_500) })
    const wrapped = new Error('turn failed', { cause: rpc })

    assert.equal(acpErrorMessage(wrapped), `turn failed: ${'x'.repeat(2_000)}...`)
  })
})
