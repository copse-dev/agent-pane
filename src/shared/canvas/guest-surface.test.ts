import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { CANVAS_TRANSPARENT_ROOT_PROBE, canvasGuestTextCss } from './guest-surface.ts'

interface StubStyle {
  backgroundColor: string
  backgroundImage: string
}

const TRANSPARENT: StubStyle = { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none' }

/** Evaluate the guest probe against stub roots, the way the guest would. */
function probe(root: StubStyle, body: StubStyle | null): unknown {
  const html = { style: root }
  const bodyElement = body ? { style: body } : null
  const document = { documentElement: html, body: bodyElement }
  const getComputedStyle = (element: { style: StubStyle }): StubStyle => element.style
  const result: unknown = runInNewContext(CANVAS_TRANSPARENT_ROOT_PROBE, {
    document,
    getComputedStyle,
  })
  return result
}

describe('canvas guest surface', () => {
  it('reports a transparent document so the host text colour applies', () => {
    assert.equal(probe(TRANSPARENT, TRANSPARENT), true)
    assert.equal(probe({ ...TRANSPARENT, backgroundColor: 'transparent' }, null), true)
  })

  it('leaves an artefact that paints its own root or body alone', () => {
    assert.equal(
      probe(TRANSPARENT, { ...TRANSPARENT, backgroundColor: 'rgb(255, 255, 255)' }),
      false,
    )
    assert.equal(probe({ ...TRANSPARENT, backgroundColor: 'rgba(10, 20, 30, 0.5)' }, null), false)
    assert.equal(
      probe(TRANSPARENT, { ...TRANSPARENT, backgroundImage: 'linear-gradient(red, blue)' }),
      false,
    )
  })

  it('injects the host colour at zero specificity', () => {
    assert.equal(
      canvasGuestTextCss('rgb(204, 204, 204)'),
      ':where(:root) { color: rgb(204, 204, 204); }',
    )
    assert.equal(
      canvasGuestTextCss(' rgba(1, 2, 3, 0.5) '),
      ':where(:root) { color: rgba(1, 2, 3, 0.5); }',
    )
  })

  it('refuses anything that is not a computed colour', () => {
    assert.equal(canvasGuestTextCss(''), null)
    assert.equal(canvasGuestTextCss('red; } body { display: none'), null)
    assert.equal(canvasGuestTextCss('var(--text-primary)'), null)
  })
})
