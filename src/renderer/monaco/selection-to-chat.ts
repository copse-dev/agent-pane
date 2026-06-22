import type * as Monaco from 'monaco-editor'
import { getPromptAttachmentHandlers } from '../attachments/prompt-attachments.ts'

export interface MonacoSelectionAttachment {
  label: string
  content: string
}

export function selectionLineRangeLabel(startLineNumber: number, endLineNumber: number): string {
  return startLineNumber === endLineNumber
    ? String(startLineNumber)
    : `${startLineNumber}-${endLineNumber}`
}

export function buildMonacoSelectionAttachment(
  editor: Monaco.editor.IStandaloneCodeEditor,
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
  editor: Monaco.editor.IStandaloneCodeEditor,
  path: string,
  detail?: string,
): boolean {
  const attachment = buildMonacoSelectionAttachment(editor, path, detail)
  if (!attachment) return false

  const handlers = getPromptAttachmentHandlers()
  if (!handlers) return false

  handlers.attachTextBlock(attachment.content, attachment.label)
  return true
}
