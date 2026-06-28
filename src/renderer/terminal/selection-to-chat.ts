import type { Terminal } from '@xterm/xterm'
import { getPromptAttachmentHandlers } from '../attachments/prompt-attachments.ts'

export interface TerminalSelectionAttachment {
  label: string
  content: string
}

/**
 * Minimal surface of the xterm Terminal we depend on, so the builder can be
 * unit-tested without constructing a real terminal.
 */
export interface TerminalSelectionSource {
  hasSelection(): boolean
  getSelection(): string
}

export function buildTerminalSelectionAttachment(
  term: TerminalSelectionSource,
  label: string,
): TerminalSelectionAttachment | null {
  if (!term.hasSelection()) return null
  const content = term.getSelection()
  if (!content.trim()) return null
  return { label, content }
}

export function attachTerminalSelectionToChat(
  term: TerminalSelectionSource,
  label: string,
): boolean {
  const attachment = buildTerminalSelectionAttachment(term, label)
  if (!attachment) return false

  const handlers = getPromptAttachmentHandlers()
  if (!handlers) return false

  handlers.attachTextBlock(attachment.content, attachment.label)
  return true
}

/** Cmd/Ctrl+L (no alt/shift), matching the Monaco selection-to-chat shortcut. */
export function isSelectionToChatKey(event: KeyboardEvent): boolean {
  const meta = event.ctrlKey || event.metaKey
  return Boolean(meta) && !event.altKey && !event.shiftKey && event.code === 'KeyL'
}

/**
 * Wire Cmd/Ctrl+L on an xterm terminal to attach the current selection to chat.
 *
 * Only intercepts the key when there is an active selection — with nothing
 * selected the event passes through so Ctrl+L still clears the screen.
 */
export function registerTerminalSelectionToChatShortcut(
  term: Terminal,
  getLabel: () => string,
): void {
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    if (!isSelectionToChatKey(event) || !term.hasSelection()) return true

    event.preventDefault()
    attachTerminalSelectionToChat(term, getLabel())
    return false
  })
}
