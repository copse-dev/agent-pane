import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { patchChildren } from './patch-children.ts'

function items(...names: string[]): HTMLLIElement[] {
  return names.map((name) => {
    const li = document.createElement('li')
    li.id = name
    return li
  })
}

function order(parent: Element): string[] {
  return [...parent.children].map((child) => child.id)
}

describe('patchChildren', () => {
  it('fills an empty parent', () => {
    const ul = document.createElement('ul')
    patchChildren(ul, items('a', 'b'))
    assert.deepEqual(order(ul), ['a', 'b'])
  })

  it('leaves nodes already in place untouched', () => {
    const ul = document.createElement('ul')
    const [a, b, c] = items('a', 'b', 'c')
    assert.ok(a && b && c)
    patchChildren(ul, [a, b, c])
    let inserts = 0
    const insertBefore = ul.insertBefore.bind(ul)
    ul.insertBefore = <T extends Node>(node: T, child: Node | null): T => {
      inserts += 1
      return insertBefore(node, child)
    }
    patchChildren(ul, [a, b, c])
    assert.equal(inserts, 0, 'nodes already in place must not be re-inserted')
    assert.deepEqual(order(ul), ['a', 'b', 'c'])
  })

  it('reorders by moving the same nodes, not recreating them', () => {
    const ul = document.createElement('ul')
    const [a, b, c] = items('a', 'b', 'c')
    assert.ok(a && b && c)
    patchChildren(ul, [a, b, c])
    patchChildren(ul, [c, a, b])
    assert.deepEqual(order(ul), ['c', 'a', 'b'])
    assert.equal(ul.children[0], c)
    assert.equal(ul.children[1], a)
    assert.equal(ul.children[2], b)
  })

  it('removes nodes that are no longer wanted', () => {
    const ul = document.createElement('ul')
    const [a, b, c] = items('a', 'b', 'c')
    assert.ok(a && b && c)
    patchChildren(ul, [a, b, c])
    patchChildren(ul, [c])
    assert.deepEqual(order(ul), ['c'])
    assert.equal(b.parentElement, null)
    patchChildren(ul, [])
    assert.deepEqual(order(ul), [])
  })

  it('swaps a replaced node in place and keeps its neighbours', () => {
    const ul = document.createElement('ul')
    const [a, b, c] = items('a', 'b', 'c')
    assert.ok(a && b && c)
    patchChildren(ul, [a, b, c])
    const [b2] = items('b2')
    assert.ok(b2)
    patchChildren(ul, [a, b2, c])
    assert.deepEqual(order(ul), ['a', 'b2', 'c'])
    assert.equal(ul.children[0], a)
    assert.equal(ul.children[2], c)
  })
})
