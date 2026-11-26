import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { el } from './helpers.ts'
import { keyed, keyedContainer, liveNode, reconcileChildren } from './keyed-reconcile.ts'

function rowFor(key: string, label: string, deps: readonly unknown[] = []): HTMLElement {
  return keyed(el('div', { class: 'row' }, label), key, deps)
}

describe('reconcileChildren', () => {
  it('keeps a row whose markup and deps are unchanged', () => {
    const parent = document.createElement('div')
    const data = { id: 'a' }
    reconcileChildren(parent, [rowFor('a', 'A', [data]), rowFor('b', 'B')])
    const [a, b] = Array.from(parent.children)

    const freshA = rowFor('a', 'A', [data])
    reconcileChildren(parent, [freshA, rowFor('b', 'B changed')])

    assert.equal(parent.children[0], a)
    assert.notEqual(parent.children[1], b)
    assert.equal(parent.children[1]?.textContent, 'B changed')
    assert.equal(liveNode(freshA), a)
  })

  it('replaces a row whose deps changed even when its markup did not', () => {
    const parent = document.createElement('div')
    reconcileChildren(parent, [rowFor('a', 'A', [{ id: 'a' }])])
    const before = parent.firstElementChild

    reconcileChildren(parent, [rowFor('a', 'A', [{ id: 'a' }])])

    assert.notEqual(parent.firstElementChild, before)
  })

  it('compares a row with its markup as built, not as changed since', () => {
    const parent = document.createElement('div')
    reconcileChildren(parent, [rowFor('a', 'A')])
    const before = parent.firstElementChild
    assert.ok(before)
    before.classList.add('hovered-by-runtime')

    reconcileChildren(parent, [rowFor('a', 'A')])

    assert.equal(parent.firstElementChild, before)
    assert.equal(before.classList.contains('hovered-by-runtime'), true)
  })

  it('keeps a container and reconciles inside it', () => {
    const parent = document.createElement('div')
    const block = (label: string, open: boolean): HTMLElement =>
      keyedContainer(
        el(
          'section',
          { class: open ? 'block open' : 'block' },
          rowFor('head', 'Head'),
          rowFor('body', label),
        ),
        'block',
      )
    reconcileChildren(parent, [block('one', false)])
    const live = parent.firstElementChild
    assert.ok(live)
    const head = live.firstElementChild
    live.classList.add('is-dragging')

    const fresh = block('two', true)
    reconcileChildren(parent, [fresh], { transientClasses: ['is-dragging'] })

    assert.equal(parent.firstElementChild, live)
    assert.equal(live.firstElementChild, head)
    assert.equal(live.lastElementChild?.textContent, 'two')
    assert.equal(live.getAttribute('class'), 'block open is-dragging')
    assert.equal(liveNode(fresh), live)
  })

  it('always replaces unkeyed elements and drops rows that are gone', () => {
    const parent = document.createElement('div')
    reconcileChildren(parent, [el('p', {}, 'note'), rowFor('a', 'A'), rowFor('b', 'B')])
    const note = parent.firstElementChild
    const b = parent.lastElementChild

    reconcileChildren(parent, [el('p', {}, 'note'), rowFor('b', 'B')])

    assert.notEqual(parent.firstElementChild, note)
    assert.equal(parent.lastElementChild, b)
    assert.equal(parent.children.length, 2)
  })

  it('moves a kept row to its new position', () => {
    const parent = document.createElement('div')
    reconcileChildren(parent, [rowFor('a', 'A'), rowFor('b', 'B')])
    const [a, b] = Array.from(parent.children)

    reconcileChildren(parent, [rowFor('b', 'B'), rowFor('a', 'A')])

    assert.deepEqual(Array.from(parent.children), [b, a])
  })

  it('leaves in place a node the caller keeps across renders', () => {
    const parent = document.createElement('div')
    const persistent = el('div', { class: 'persistent' })
    reconcileChildren(parent, [persistent])

    reconcileChildren(parent, [persistent])

    assert.equal(parent.firstElementChild, persistent)
  })
})
