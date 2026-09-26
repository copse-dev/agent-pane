import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ipcErrorMessage, unwrapIpcErrorText } from './ipc-error-message.ts'

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

  it('drops the wrapping when the original had no Error prefix', () => {
    assert.equal(
      ipcErrorMessage(new Error(`Error invoking remote method 'x:y': Host key rejected`), 'f'),
      'Host key rejected',
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

  it('keeps other error names, which may carry meaning for the caller', () => {
    assert.equal(
      ipcErrorMessage(new Error(`Error invoking remote method 'c:d': ClassifierError: 401`), 'f'),
      'ClassifierError: 401',
    )
  })
})

describe('unwrapIpcErrorText', () => {
  it('peels however many layers it is given', () => {
    assert.equal(
      unwrapIpcErrorText(
        `Error: Error invoking remote method 'a:b': Error: Error invoking remote method 'a:b': Error: boom`,
      ),
      'boom',
    )
  })

  it('leaves unwrapped text alone and trims what remains', () => {
    assert.equal(unwrapIpcErrorText('Port must be a number'), 'Port must be a number')
    assert.equal(unwrapIpcErrorText('Error: '), '')
  })
})
