import type * as Monaco from 'monaco-editor'
import { getPromptAttachmentHandlers } from '../attachments/prompt-attachments.ts'

export interface MonacoSelectionAttachment {
  label: string
  content: string
}

export interface MonacoSelectionContext {
  path: string
  detail?: string
}

export interface MonacoSelectionSource {
  getSelection(): Pick<
    Monaco.Selection,
    'endColumn' | 'endLineNumber' | 'isEmpty' | 'startColumn' | 'startLineNumber'
  > | null
  getModel(): {
    getValueInRange(
      range: Pick<
        Monaco.Selection,
        'endColumn' | 'endLineNumber' | 'isEmpty' | 'startColumn' | 'startLineNumber'
      >,
    ): string
    isDisposed(): boolean
  } | null
}

export interface MonacoShortcutSource extends MonacoSelectionSource {
  onKeyDown(
    listener: (event: {
      browserEvent: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>
      keyCode: number
      preventDefault(): void
      stopPropagation(): void
    }) => void,
  ): { dispose(): void }
}

export interface MonacoShortcutApi {
  KeyCode: { KeyL: number }
}

export function selectionLineRangeLabel(startLineNumber: number, endLineNumber: number): string {
  return startLineNumber === endLineNumber
    ? String(startLineNumber)
    : `${String(startLineNumber)}-${String(endLineNumber)}`
}

export function buildMonacoSelectionAttachment(
  editor: MonacoSelectionSource,
  path: string,
  detail?: string,
): MonacoSelectionAttachment | null {
  const selection = editor.getSelection()
  const model = editor.getModel()
  if (!selection || selection.isEmpty() || !model || model.isDisposed()) return null

  const content = model.getValueInRange(selection)
  if (!content.trim()) return null

  const range = selectionLineRangeLabel(selection.startLineNumber, selection.endLineNumber)
  const suffix = detail ? ` (${detail})` : ''
  return {
    label: `${path}:${range}${suffix}`,
    content,
  }
}

export function attachMonacoSelectionToChat(
  editor: MonacoSelectionSource,
  path: string,
  detail?: string,
): boolean {
  const attachment = buildMonacoSelectionAttachment(editor, path, detail)
  if (!attachment) return false

  const handlers = getPromptAttachmentHandlers()
  if (!handlers) return false

  handlers.attachTextBlock(attachment.content, attachment.label)
  handlers.focusComposer?.()
  return true
}

export function registerMonacoSelectionToChatShortcut(
  editor: MonacoShortcutSource,
  monaco: MonacoShortcutApi,
  getContext: () => MonacoSelectionContext | null,
): { dispose(): void } {
  return editor.onKeyDown((event) => {
    const browserEvent = event.browserEvent
    const meta = browserEvent.ctrlKey || browserEvent.metaKey
    if (
      !meta ||
      browserEvent.altKey ||
      browserEvent.shiftKey ||
      event.keyCode !== monaco.KeyCode.KeyL
    )
      return

    const context = getContext()
    if (!context) return

    event.preventDefault()
    event.stopPropagation()
    attachMonacoSelectionToChat(editor, context.path, context.detail)
  })
}
