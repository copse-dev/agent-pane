import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
  artefactUriFromToolResult,
  getArtefactPreview,
  requestArtefactShow,
  resetArtefactPreviewsForTest,
  setArtefactPreview,
  setArtefactShowHandler,
} from './artefact-previews.ts'

describe('artefact preview registry', () => {
  beforeEach(() => {
    resetArtefactPreviewsForTest()
  })

  it('stores and returns a preview by title', () => {
    setArtefactPreview('Sales Dashboard', 'data:image/png;base64,AAA')
    assert.equal(getArtefactPreview('Sales Dashboard'), 'data:image/png;base64,AAA')
  })

  it('keeps the newest render, since the tab shows the newest too', () => {
    setArtefactPreview('Sales Dashboard', 'data:image/png;base64,V1')
    setArtefactPreview('Sales Dashboard', 'data:image/png;base64,V2')
    assert.equal(getArtefactPreview('Sales Dashboard'), 'data:image/png;base64,V2')
  })

  it('ignores a missing preview rather than clearing the one it has', () => {
    // A capture can fail on any single render (see `CanvasArtefact.preview`);
    // that must not blank a thumbnail the card is already showing.
    setArtefactPreview('Sales Dashboard', 'data:image/png;base64,V1')
    setArtefactPreview('Sales Dashboard', undefined)
    assert.equal(getArtefactPreview('Sales Dashboard'), 'data:image/png;base64,V1')
  })

  it('returns undefined for a title never rendered', () => {
    assert.equal(getArtefactPreview('Nothing Here'), undefined)
  })

  it('routes a show request to the registered handler', () => {
    const shown: string[] = []
    setArtefactShowHandler((title) => shown.push(title))
    requestArtefactShow('Sales Dashboard')
    assert.deepEqual(shown, ['Sales Dashboard'])
  })

  it('is inert with no handler registered', () => {
    assert.doesNotThrow(() => {
      requestArtefactShow('Sales Dashboard')
    })
  })
})

describe('artefactUriFromToolResult', () => {
  it('pulls the uri out of the canvas summary line', () => {
    const result =
      '[ui resource: ui://canvas/sales-dashboard (text/html, 4.2 KB) — rendered in the canvas]'
    assert.equal(artefactUriFromToolResult(result), 'ui://canvas/sales-dashboard')
  })

  it('ignores results from tools that rendered nothing', () => {
    assert.equal(artefactUriFromToolResult('Wrote 12 lines to src/index.ts'), null)
    assert.equal(artefactUriFromToolResult(''), null)
    assert.equal(artefactUriFromToolResult(null), null)
  })

  it('does not swallow the trailing summary text', () => {
    // The regex must stop at the space before `(text/html…`, or the derived
    // title would carry the size suffix and never match the pane's tab.
    const uri = artefactUriFromToolResult('[ui resource: ui://canvas/pricing (text/html, 1.0 KB)]')
    assert.equal(uri, 'ui://canvas/pricing')
  })
})
