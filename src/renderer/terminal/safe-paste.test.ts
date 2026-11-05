import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { installSafeTerminalPaste, sanitizeTerminalPaste } from './safe-paste.ts'
import type { ConfirmDialogRequest } from '../views/confirm-dialog.ts'

interface PasteFixture {
  sent: string[]
  term: {
    modes: { bracketedPasteMode: boolean }
    options: { ignoreBracketedPasteMode: boolean }
    paste: (text: string) => void
    focus: () => void
  }
  container: HTMLDivElement
  textarea: HTMLTextAreaElement
  paste: (text: string) => Promise<void>
  setSession: (id: string | null) => void
}

function fixture(
  confirm: (request: ConfirmDialogRequest) => Promise<boolean> = async () => false,
): PasteFixture {
  const sent: string[] = []
  let sessionId: string | null = 'original'
  const container = document.createElement('div')
  const textarea = document.createElement('textarea')
  container.append(textarea)
  const term = {
    modes: { bracketedPasteMode: false },
    options: { ignoreBracketedPasteMode: false },
    paste: (text: string): void => {
      sent.push(text)
    },
    focus: (): void => {},
  }
  const paste = installSafeTerminalPaste(term, container, () => sessionId, confirm)
  return {
    sent,
    term,
    container,
    textarea,
    paste,
    setSession: (id: string | null): void => {
      sessionId = id
    },
  }
}

describe('safe terminal paste', () => {
  it('replaces C0, DEL, and C1 controls while preserving tabs, line endings, and Unicode', () => {
    for (let code = 0; code < 160; code++) {
      const character = String.fromCharCode(code)
      const allowed = code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127)
      assert.equal(sanitizeTerminalPaste(character), allowed ? character : ' ')
    }
    assert.equal(sanitizeTerminalPaste('café 東京 😀\t\r\n'), 'café 東京 😀\t\r\n')
    assert.equal(sanitizeTerminalPaste('\x1b[201~\x03echo bad\x15'), ' [201~ echo bad ')
  })

  for (const ending of ['\r', '\n', '\r\n']) {
    it(`does not forward ${JSON.stringify(ending)} before confirmation, and cancellation sends nothing`, async () => {
      let resolve: (value: boolean) => void = () => {}
      const f = fixture(
        () =>
          new Promise<boolean>((done) => {
            resolve = done
          }),
      )
      const pending = f.paste('echo test' + ending)
      assert.deepEqual(f.sent, [])
      resolve(false)
      await pending
      assert.deepEqual(f.sent, [])
    })
  }

  it('confirms the sanitized preview and forwards only sanitized input', async () => {
    let detail = ''
    const f = fixture(async (request) => {
      detail =
        request.detail instanceof Node ? (request.detail.textContent ?? '') : (request.detail ?? '')
      return true
    })
    await f.paste('echo\x03 test\r')
    assert.ok(detail.includes('echo  test'))
    assert.equal(detail.includes('\x03'), false)
    assert.deepEqual(f.sent, ['echo  test\r'])
  })

  it('allows safe single-line paste without a dialog', async () => {
    const f = fixture(async () => assert.fail('unexpected confirmation'))
    await f.paste('echo\t東京')
    assert.deepEqual(f.sent, ['echo\t東京'])
  })

  it('preserves multiline bracketed paste but still sanitizes escape and interrupt characters', async () => {
    const f = fixture(async () => assert.fail('unexpected confirmation'))
    f.term.modes.bracketedPasteMode = true
    await f.paste('one\n\x1b[201~\x03two\r')
    assert.deepEqual(f.sent, ['one\n [201~ two\r'])
  })

  it('requires confirmation when bracketed paste is ignored', async () => {
    const f = fixture()
    f.term.modes.bracketedPasteMode = true
    f.term.options.ignoreBracketedPasteMode = true
    await f.paste('one\n')
    assert.deepEqual(f.sent, [])
  })

  for (const nextSession of [null, 'replacement']) {
    it(`discards confirmation for a closed or replaced session (${String(nextSession)})`, async () => {
      const f = fixture(async () => {
        f.setSession(nextSession)
        return true
      })
      await f.paste('echo test\n')
      assert.deepEqual(f.sent, [])
    })
  }

  it('intercepts the clipboard event before xterm can consume it', async () => {
    const f = fixture(async () => true)
    let nativePaste = false
    f.textarea.addEventListener('paste', () => {
      nativePaste = true
    })
    const transfer = new window.DataTransfer()
    transfer.setData('text/plain', 'echo\x03 test\r')
    const event = new window.ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    })
    f.textarea.dispatchEvent(event)
    assert.equal(event.defaultPrevented, true)
    assert.equal(nativePaste, false)
    assert.deepEqual(f.sent, [])
    await Promise.resolve()
    assert.deepEqual(f.sent, ['echo  test\r'])
  })

  it('routes text drops through confirmation and blocks native drop handling', async () => {
    const f = fixture()
    const transfer = new window.DataTransfer()
    transfer.setData('text/plain', 'echo test\r')
    const event = new window.DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    })
    f.textarea.dispatchEvent(event)
    await Promise.resolve()
    assert.equal(event.defaultPrevented, true)
    assert.deepEqual(f.sent, [])
  })

  it('does not send file drops as shell input', async () => {
    const f = fixture(async () => assert.fail('unexpected confirmation'))
    const transfer = new window.DataTransfer()
    transfer.items.add(new window.File([''], 'danger\r'))
    transfer.setData('text/plain', 'danger\r')
    const event = new window.DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    })
    f.textarea.dispatchEvent(event)
    await Promise.resolve()
    assert.equal(event.defaultPrevented, true)
    assert.deepEqual(f.sent, [])
  })
})
