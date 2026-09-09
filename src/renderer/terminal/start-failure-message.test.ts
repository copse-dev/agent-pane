import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { terminalStartFailureMessage } from './start-failure-message.ts'

describe('terminalStartFailureMessage', () => {
  it('says what the reported failure means, without the ids or the IPC wrapping', () => {
    // Verbatim from #2484 — what the pane printed at the user.
    const raw = new Error(
      `Error invoking remote method 'terminal:create': Error: Thread "ec57a9a6-ebfd-4a85-9c82-a99c5b68e0ee" does not belong to project "e2e-mermaid-project"`,
    )
    const message = terminalStartFailureMessage(raw)
    assert.match(message, /thread from another project/i)
    assert.match(message, /open a new one/i)
    assert.doesNotMatch(message, /invoking remote method/)
    assert.doesNotMatch(message, /ec57a9a6/)
    assert.doesNotMatch(message, /e2e-mermaid-project/)
  })

  it('keeps a failure it does not recognise, unwrapped', () => {
    // Swallowing an unknown cause would trade one unreadable message for no
    // message at all.
    const raw = new Error(
      `Error invoking remote method 'terminal:create': Error: spawn /bin/zsh ENOENT`,
    )
    assert.equal(terminalStartFailureMessage(raw), 'spawn /bin/zsh ENOENT')
  })

  it('peels however many layers of wrapping it is given', () => {
    // Two deep today; the shape is Electron's, not ours, so do not depend on it.
    assert.equal(
      terminalStartFailureMessage(
        `Error: Error invoking remote method 'terminal:create': Error: Error invoking remote method 'terminal:create': Error: boom`,
      ),
      'boom',
    )
  })

  it('handles a plain string and a non-Error throw', () => {
    assert.equal(
      terminalStartFailureMessage('Terminal access was not approved'),
      'Terminal access was not approved',
    )
    assert.equal(terminalStartFailureMessage({ nope: true }), '[object Object]')
  })

  it('never renders empty, so the line is not just a red prefix', () => {
    assert.equal(terminalStartFailureMessage(new Error('')), 'The shell could not be started.')
    assert.equal(
      terminalStartFailureMessage(new Error('Error: ')),
      'The shell could not be started.',
    )
  })

  it('does not mistake a different thread-and-project sentence for the known one', () => {
    // The replacement asserts a specific cause; it must only fire on the
    // message that actually has that cause.
    const other = new Error('Thread "a" does not belong to project "b" (and other things)')
    assert.match(terminalStartFailureMessage(other), /and other things/)
  })
})
