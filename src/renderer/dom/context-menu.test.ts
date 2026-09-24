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

  it('appends into an open dialog when withinDialog is inside one, not document.body', () => {
    const dialog = document.createElement('dialog')
    const content = document.createElement('div')
    dialog.append(content)
    document.body.append(dialog)
    dialog.open = true // happy-dom does not implement showModal(); flip the reflected attribute.

    showContextMenu(10, 20, [{ label: 'Copy', onSelect: (): void => {} }], content)

    const menu = document.querySelector('.context-menu')
    assert.ok(menu)
    assert.equal(menu.parentElement, dialog, 'menu must render inside the dialog top layer')
    assert.equal(document.body.querySelector(':scope > .context-menu'), null)
  })

  it('falls back to document.body when withinDialog is outside any dialog', () => {
    const host = document.createElement('div')
    document.body.append(host)

    showContextMenu(10, 20, [{ label: 'Copy', onSelect: (): void => {} }], host)

    const menu = document.querySelector('.context-menu')
    assert.equal(menu?.parentElement, document.body)
  })
})
