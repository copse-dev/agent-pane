import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ipcErrorMessage } from './ipc-error-message.ts'

describe('ipcErrorMessage', () => {
  it("strips Electron's remote-method prefix", () => {
    assert.equal(
      ipcErrorMessage(
        new Error(
          "Error invoking remote method 'roadmap:create': Error: Roadmap prompt must not be empty",
        ),
        'fallback',
      ),
      'Roadmap prompt must not be empty',
    )
  })

  it('keeps a plain error message and falls back for non-errors or empty text', () => {
    assert.equal(ipcErrorMessage(new Error('disk full'), 'fallback'), 'disk full')
    assert.equal(ipcErrorMessage('nope', 'fallback'), 'fallback')
    assert.equal(
      ipcErrorMessage(new Error("Error invoking remote method 'x:y': "), 'fallback'),
      'fallback',
    )
  })
})
