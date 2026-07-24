import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dismissContextMenu, showContextMenu } from './context-menu.ts'

afterEach(() => {
  dismissContextMenu()
  document.body.replaceChildren()
})

describe('showContextMenu', () => {
  it('selects on mousedown without requiring a click', () => {
    let selected = 0
    showContextMenu(10, 20, [
      {
        label: 'Rename',
        onSelect: (): void => {
          selected += 1
        },
      },
    ])

    const item = document.querySelector<HTMLButtonElement>('.context-menu-item')
    assert.ok(item)
    item.dispatchEvent(
      new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }),
    )

    assert.equal(selected, 1)
    assert.equal(document.querySelector('.context-menu'), null)
  })

  it('does not double-fire when mousedown is followed by click', () => {
    let selected = 0
    showContextMenu(10, 20, [
      {
        label: 'Archive',
        onSelect: (): void => {
          selected += 1
        },
      },
    ])

    const item = document.querySelector<HTMLButtonElement>('.context-menu-item')
    assert.ok(item)
    item.dispatchEvent(
      new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }),
    )
    // Menu is already gone; a stale click must not call onSelect again.
    item.click()
    assert.equal(selected, 1)
  })
})
