import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isTypingTarget, matchPanelShortcut } from './keyboard-shortcuts.ts'

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

  it('isTypingTarget detects editable fields', () => {
    assert.equal(isTypingTarget(fakeElement('TEXTAREA')), true)
    assert.equal(isTypingTarget(fakeElement('INPUT')), true)
    assert.equal(isTypingTarget(fakeElement('DIV', true)), true)
    assert.equal(isTypingTarget(fakeElement('DIV', false)), false)
  })
})
