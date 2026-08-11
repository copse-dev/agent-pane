// Drop geometry and payload decoding for sidebar drags (issue #1685).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  dropIntent,
  isSidebarDrag,
  parseSidebarDrag,
  serializeSidebarDrag,
  SIDEBAR_DRAG_MIME,
} from './projects-drag.ts'

const ROW = { top: 100, height: 20 } as const

describe('dropIntent — plain row', () => {
  it('splits at the midpoint', () => {
    assert.equal(dropIntent(104, ROW), 'before')
    assert.equal(dropIntent(109, ROW), 'before')
    assert.equal(dropIntent(110, ROW), 'after')
    assert.equal(dropIntent(118, ROW), 'after')
  })

  it('never returns into, even at the exact centre', () => {
    assert.equal(dropIntent(110, ROW), 'after')
  })

  it('clamps a pointer above or below the row to the nearer edge', () => {
    // A dragover can be delivered with a pointer just outside the row it
    // targets; the answer still has to be one of the two sides.
    assert.equal(dropIntent(80, ROW), 'before')
    assert.equal(dropIntent(200, ROW), 'after')
  })

  it('treats an unlaid-out row as its own leading edge', () => {
    // happy-dom and a hidden row both report height 0, where there is no
    // midpoint to compare against.
    assert.equal(dropIntent(0, { top: 0, height: 0 }), 'before')
  })
})

describe('dropIntent — group header', () => {
  const into = { allowInto: true } as const

  it('reorders from the outer quarters and nests from the middle', () => {
    assert.equal(dropIntent(102, ROW, into), 'before')
    assert.equal(dropIntent(108, ROW, into), 'into')
    assert.equal(dropIntent(110, ROW, into), 'into')
    assert.equal(dropIntent(112, ROW, into), 'into')
    assert.equal(dropIntent(118, ROW, into), 'after')
  })

  it('keeps a usable nesting band — the middle half of the row', () => {
    // Without this band there is no pointer position that means "put this
    // project in this group", which is the whole point of a group header.
    const middle = [105, 107, 110, 113, 114]
    for (const y of middle) assert.equal(dropIntent(y, ROW, into), 'into', `y=${String(y)}`)
  })
})

describe('sidebar drag payload', () => {
  it('round-trips a project drag', () => {
    assert.deepEqual(parseSidebarDrag(serializeSidebarDrag({ kind: 'project', id: 'p1' })), {
      kind: 'project',
      id: 'p1',
    })
  })

  it('round-trips a group drag', () => {
    assert.deepEqual(parseSidebarDrag(serializeSidebarDrag({ kind: 'group', id: 'g1' })), {
      kind: 'group',
      id: 'g1',
    })
  })

  it('rejects anything that is not one of ours', () => {
    // Drops arrive from outside the app; a malformed payload has to read as
    // "not a sidebar drag" rather than move a project with an empty id.
    assert.equal(parseSidebarDrag(''), null)
    assert.equal(parseSidebarDrag('not json'), null)
    assert.equal(parseSidebarDrag('"a string"'), null)
    assert.equal(parseSidebarDrag('[{"kind":"project","id":"p1"}]'), null)
    assert.equal(parseSidebarDrag('{"kind":"thread","id":"t1"}'), null)
    assert.equal(parseSidebarDrag('{"kind":"project"}'), null)
    assert.equal(parseSidebarDrag('{"kind":"project","id":""}'), null)
    assert.equal(parseSidebarDrag('{"kind":"project","id":42}'), null)
  })
})

describe('isSidebarDrag', () => {
  it('recognises our own MIME among the dragged types', () => {
    assert.equal(isSidebarDrag([SIDEBAR_DRAG_MIME]), true)
    assert.equal(isSidebarDrag(['text/plain', SIDEBAR_DRAG_MIME]), true)
  })

  it('rejects a file drag and a missing dataTransfer', () => {
    // A folder dragged in from Finder must not paint reorder indicators.
    assert.equal(isSidebarDrag(['Files']), false)
    assert.equal(isSidebarDrag(['text/plain']), false)
    assert.equal(isSidebarDrag([]), false)
    assert.equal(isSidebarDrag(undefined), false)
  })
})
