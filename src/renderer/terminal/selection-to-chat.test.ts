import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerPromptAttachments } from '../attachments/prompt-attachments.ts'
import {
  attachTerminalSelectionToChat,
  buildTerminalSelectionAttachment,
  isSelectionToChatKey,
  type TerminalSelectionSource,
} from './selection-to-chat.ts'

function fakeTerm(hasSelection: boolean, selection: string): TerminalSelectionSource {
  return {
    hasSelection: () => hasSelection,
    getSelection: () => selection,
  }
}

function fakeKey(init: Partial<KeyboardEvent>): KeyboardEvent {
  return { code: 'KeyL', ...init } as KeyboardEvent
}

describe('terminal selection-to-chat', () => {
  it('builds a labeled attachment from the terminal selection', () => {
    const attachment = buildTerminalSelectionAttachment(
      fakeTerm(true, '$ ls\nsrc tests\n'),
      'Terminal 1',
    )

    assert.deepEqual(attachment, {
      label: 'Terminal 1',
      content: '$ ls\nsrc tests\n',
    })
  })

  it('ignores empty or whitespace-only selections', () => {
    assert.equal(buildTerminalSelectionAttachment(fakeTerm(false, ''), 'Terminal 1'), null)
    assert.equal(buildTerminalSelectionAttachment(fakeTerm(true, '   \n'), 'Terminal 1'), null)
  })

  it('recognizes Cmd/Ctrl+L only without alt/shift modifiers', () => {
    assert.equal(isSelectionToChatKey(fakeKey({ metaKey: true })), true)
    assert.equal(isSelectionToChatKey(fakeKey({ ctrlKey: true })), true)
    assert.equal(isSelectionToChatKey(fakeKey({ ctrlKey: true, shiftKey: true })), false)
    assert.equal(isSelectionToChatKey(fakeKey({ ctrlKey: true, altKey: true })), false)
    assert.equal(isSelectionToChatKey(fakeKey({ metaKey: true, code: 'KeyK' })), false)
    assert.equal(isSelectionToChatKey(fakeKey({ code: 'KeyL' })), false)
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

    const ok = attachTerminalSelectionToChat(fakeTerm(true, 'output line'), 'Terminal 1')

    unregister()
    assert.equal(ok, true)
    assert.equal(attachedContent, 'output line')
    assert.equal(attachedLabel, 'Terminal 1')
    assert.equal(focused, true)
  })
})
