import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decodeShellInMessage } from './shell-link.ts'

describe('decodeShellInMessage', () => {
  it('accepts a well-formed window event', () => {
    assert.deepEqual(decodeShellInMessage({ op: 'window-event', winId: 3, event: 'closed' }), {
      op: 'window-event',
      winId: 3,
      event: 'closed',
    })
  })

  it('rejects unknown ops, events, and malformed fields', () => {
    assert.equal(decodeShellInMessage({ op: 'window', winId: 3, event: 'closed' }), null)
    assert.equal(decodeShellInMessage({ op: 'window-event', winId: 3, event: 'resized' }), null)
    assert.equal(decodeShellInMessage({ op: 'window-event', winId: '3', event: 'focus' }), null)
    assert.equal(decodeShellInMessage(null), null)
    assert.equal(decodeShellInMessage(['window-event']), null)
  })
})
