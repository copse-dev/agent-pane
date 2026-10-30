import type { Terminal } from '@xterm/xterm'
import { el } from '../dom/helpers.ts'
import { showConfirmDialog, type ConfirmDialogRequest } from '../views/confirm-dialog.ts'

/** Keep text and whitespace, but never send pasted terminal control sequences. */
export function sanitizeTerminalPaste(text: string): string {
  return Array.from(text, (character) => {
    const code = character.charCodeAt(0)
    const allowedWhitespace = code === 9 || code === 10 || code === 13
    return (!allowedWhitespace && code < 32) || (code >= 127 && code <= 159) ? ' ' : character
  }).join('')
}

/**
 * Own all user paste entry points before xterm can forward them to the PTY.
 * Typing and programmatic command execution do not pass through this handler.
 */
export function installSafeTerminalPaste(
  term: Pick<Terminal, 'paste' | 'focus'> & {
    readonly modes: Pick<Terminal['modes'], 'bracketedPasteMode'>
    readonly options: Pick<Terminal['options'], 'ignoreBracketedPasteMode'>
  },
  container: HTMLElement,
  getSessionId: () => string | null,
  confirm: (request: ConfirmDialogRequest) => Promise<boolean> = showConfirmDialog,
): (text: string) => Promise<void> {
  async function paste(text: string): Promise<void> {
    const sessionId = getSessionId()
    if (!sessionId || !text) return
    const sanitized = sanitizeTerminalPaste(text)
    const bracketed = term.modes.bracketedPasteMode && !term.options.ignoreBracketedPasteMode
    if (!bracketed && (sanitized.includes('\r') || sanitized.includes('\n'))) {
      const preview = el(
        'code',
        { class: 'terminal-paste-preview' },
        sanitized.replace(/\r\n|\r/g, '\n').slice(0, 2000),
      )
      const confirmed = await confirm({
        message: 'Paste text that may run commands?',
        detail: el(
          'span',
          {},
          'Line breaks can run commands immediately in this terminal. Only paste text you trust.\n\n',
          preview,
          sanitized.length > 2000 ? '\nPreview truncated. The full text will be pasted.' : '',
        ),
        confirmLabel: 'Paste',
      })
      if (!confirmed) return
    }
    // A dialog can outlive its tab or the PTY it was opened for.
    if (getSessionId() !== sessionId) return
    term.paste(sanitized)
    term.focus()
  }

  function pasteFromEvent(text: string): void {
    void paste(text).catch((error: unknown) => {
      console.warn('Could not paste into terminal', error)
    })
  }

  container.addEventListener(
    'paste',
    (event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      pasteFromEvent(event.clipboardData?.getData('text/plain') ?? '')
    },
    { capture: true },
  )
  container.addEventListener('dragover', (event) => {
    event.preventDefault()
  })
  container.addEventListener(
    'drop',
    (event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      // File drops must not navigate Electron or turn a filename into shell input.
      if (event.dataTransfer && event.dataTransfer.files.length === 0) {
        pasteFromEvent(event.dataTransfer.getData('text/plain'))
      }
    },
    { capture: true },
  )
  return paste
}
