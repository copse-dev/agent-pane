import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type * as Monaco from 'monaco-editor'
import { registerPromptAttachments } from '../attachments/prompt-attachments.ts'
import {
  attachMonacoSelectionToChat,
  buildMonacoSelectionAttachment,
  selectionLineRangeLabel,
} from './selection-to-chat.ts'

function fakeEditor(
  selection: {
    startLineNumber: number
    endLineNumber: number
    isEmpty(): boolean
  } | null,
  content: string,
): Monaco.editor.IStandaloneCodeEditor {
  return {
    getSelection: () => selection,
    getModel: () => ({
      isDisposed: () => false,
      getValueInRange: () => content,
    }),
  } as unknown as Monaco.editor.IStandaloneCodeEditor
}

describe('selection-to-chat', () => {
  it('formats single-line and multi-line ranges', () => {
    assert.equal(selectionLineRangeLabel(7, 7), '7')
    assert.equal(selectionLineRangeLabel(7, 9), '7-9')
  })

  it('builds a labeled attachment from an editor selection', () => {
    const attachment = buildMonacoSelectionAttachment(
      fakeEditor({ startLineNumber: 3, endLineNumber: 5, isEmpty: () => false }, 'const x = 1\n'),
      'src/example.ts',
      'after',
    )

    assert.deepEqual(attachment, {
      label: 'src/example.ts:3-5 (after)',
      content: 'const x = 1\n',
    })
  })

  it('ignores empty or whitespace-only selections', () => {
    assert.equal(
      buildMonacoSelectionAttachment(
        fakeEditor({ startLineNumber: 1, endLineNumber: 1, isEmpty: () => true }, 'const x = 1'),
        'src/example.ts',
      ),
      null,
    )
    assert.equal(
      buildMonacoSelectionAttachment(
        fakeEditor({ startLineNumber: 1, endLineNumber: 2, isEmpty: () => false }, '\n  '),
        'src/example.ts',
      ),
      null,
    )
  })

  it('focuses the chat composer after attaching a selection', () => {
    let attachedContent: string | null = null
    let attachedLabel: string | undefined
    let focused = false
    const unregister = registerPromptAttachments({
      attachFile: () => {},
      attachTextBlock: (content, label) => {
        attachedContent = content
        attachedLabel = label
      },
      attachImage: () => {},
      focusComposer: () => {
        focused = true
      },
    })

    const ok = attachMonacoSelectionToChat(
      fakeEditor({ startLineNumber: 1, endLineNumber: 1, isEmpty: () => false }, 'hello'),
      'src/example.ts',
    )

    unregister()
    assert.equal(ok, true)
    assert.equal(attachedContent, 'hello')
    assert.equal(attachedLabel, 'src/example.ts:1')
    assert.equal(focused, true)
  })
})
