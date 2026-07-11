import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isTypingTarget,
  matchNewThreadShortcut,
  matchPanelShortcut,
  matchFindInChatShortcut,
} from './keyboard-shortcuts.ts'

function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  return { ...init } as KeyboardEvent
}

function fakeElement(tagName: string, contentEditable = false): HTMLElement {
  return { tagName, isContentEditable: contentEditable } as HTMLElement
}

describe('keyboard-shortcuts', () => {
  it('matchPanelShortcut follows VS Code panel chords', () => {
    assert.deepEqual(matchPanelShortcut(keyEvent({ ctrlKey: true, key: 'b' })), 'togglePanel')
    assert.deepEqual(matchPanelShortcut(keyEvent({ ctrlKey: true, key: 'j' })), 'togglePanel')
    assert.deepEqual(matchPanelShortcut(keyEvent({ metaKey: true, shiftKey: true, key: 'E' })), {
      openPanel: 'explorer',
    })
    assert.deepEqual(matchPanelShortcut(keyEvent({ ctrlKey: true, shiftKey: true, key: 'g' })), {
      openPanel: 'changes',
    })
    assert.deepEqual(matchPanelShortcut(keyEvent({ ctrlKey: true, shiftKey: true, key: 'b' })), {
      openPanel: 'browser',
    })
    assert.deepEqual(matchPanelShortcut(keyEvent({ ctrlKey: true, key: '`' })), {
      openPanel: 'terminal',
    })
    assert.deepEqual(matchPanelShortcut(keyEvent({ ctrlKey: true, code: 'Backquote' })), {
      openPanel: 'terminal',
    })
  })

  it('matchPanelShortcut ignores unrelated chords', () => {
    assert.equal(matchPanelShortcut(keyEvent({ ctrlKey: true, key: 't' })), null)
    assert.equal(matchPanelShortcut(keyEvent({ ctrlKey: true, shiftKey: true, key: 't' })), null)
    assert.equal(matchPanelShortcut(keyEvent({ altKey: true, ctrlKey: true, key: 'b' })), null)
  })

  it('matchNewThreadShortcut matches Cmd/Ctrl+N', () => {
    assert.equal(matchNewThreadShortcut(keyEvent({ ctrlKey: true, key: 'n' })), true)
    assert.equal(matchNewThreadShortcut(keyEvent({ metaKey: true, key: 'N' })), true)
  })

  it('matchNewThreadShortcut ignores modified or unrelated chords', () => {
    assert.equal(matchNewThreadShortcut(keyEvent({ key: 'n' })), false)
    assert.equal(
      matchNewThreadShortcut(keyEvent({ ctrlKey: true, shiftKey: true, key: 'n' })),
      false,
    )
    assert.equal(matchNewThreadShortcut(keyEvent({ ctrlKey: true, altKey: true, key: 'n' })), false)
    assert.equal(matchNewThreadShortcut(keyEvent({ ctrlKey: true, key: 'b' })), false)
  })

  it('matchFindInChatShortcut matches Cmd/Ctrl+F', () => {
    assert.equal(matchFindInChatShortcut(keyEvent({ ctrlKey: true, key: 'f' })), true)
    assert.equal(matchFindInChatShortcut(keyEvent({ metaKey: true, key: 'F' })), true)
  })

  it('matchFindInChatShortcut ignores modified or unrelated chords', () => {
    assert.equal(matchFindInChatShortcut(keyEvent({ key: 'f' })), false)
    assert.equal(
      matchFindInChatShortcut(keyEvent({ ctrlKey: true, shiftKey: true, key: 'f' })),
      false,
    )
    assert.equal(
      matchFindInChatShortcut(keyEvent({ metaKey: true, altKey: true, key: 'f' })),
      false,
    )
    assert.equal(matchFindInChatShortcut(keyEvent({ ctrlKey: true, key: 'p' })), false)
  })

  it('isTypingTarget detects editable fields', () => {
    assert.equal(isTypingTarget(fakeElement('TEXTAREA')), true)
    assert.equal(isTypingTarget(fakeElement('INPUT')), true)
    assert.equal(isTypingTarget(fakeElement('DIV', true)), true)
    assert.equal(isTypingTarget(fakeElement('DIV', false)), false)
  })
})
