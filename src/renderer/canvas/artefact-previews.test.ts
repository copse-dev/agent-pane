import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import type { CanvasArtefactSummary } from '@shared/types/canvas.ts'
import { createPendingApi } from '../fake-api.test-support.ts'
import {
  artefactUriFromToolResult,
  getArtefactPreview,
  hydrateArtefactPreviews,
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
    setArtefactPreview('thread-a', 'Sales Dashboard', 'data:image/png;base64,AAA')
    assert.equal(getArtefactPreview('thread-a', 'Sales Dashboard'), 'data:image/png;base64,AAA')
  })

  it('keeps the newest render, since the tab shows the newest too', () => {
    setArtefactPreview('thread-a', 'Sales Dashboard', 'data:image/png;base64,V1')
    setArtefactPreview('thread-a', 'Sales Dashboard', 'data:image/png;base64,V2')
    assert.equal(getArtefactPreview('thread-a', 'Sales Dashboard'), 'data:image/png;base64,V2')
  })

  it('does not expose a same-title preview to another thread', () => {
    setArtefactPreview('thread-a', 'Sales Dashboard', 'data:image/png;base64,A')
    assert.equal(getArtefactPreview('thread-b', 'Sales Dashboard'), undefined)
  })

  it('ignores a missing preview rather than clearing the one it has', () => {
    // A capture can fail on any single render (see `CanvasArtefact.preview`);
    // that must not blank a thumbnail the card is already showing.
    setArtefactPreview('thread-a', 'Sales Dashboard', 'data:image/png;base64,V1')
    setArtefactPreview('thread-a', 'Sales Dashboard', undefined)
    assert.equal(getArtefactPreview('thread-a', 'Sales Dashboard'), 'data:image/png;base64,V1')
  })

  it('returns undefined for a title never rendered', () => {
    assert.equal(getArtefactPreview('thread-a', 'Nothing Here'), undefined)
  })

  it('routes a show request to the registered handler', () => {
    const shown: Array<[string, string]> = []
    setArtefactShowHandler((threadId, title) => shown.push([threadId, title]))
    requestArtefactShow('thread-a', 'Sales Dashboard')
    assert.deepEqual(shown, [['thread-a', 'Sales Dashboard']])
  })

  it('is inert with no handler registered', () => {
    assert.doesNotThrow(() => {
      requestArtefactShow('thread-a', 'Sales Dashboard')
    })
  })
})

describe('hydrateArtefactPreviews', () => {
  beforeEach(() => {
    resetArtefactPreviewsForTest()
  })

  it('restores thumbnails saved by an earlier session', async () => {
    const api = createPendingApi({
      'canvas.listArtefacts': async (): Promise<CanvasArtefactSummary[]> => [
        { title: 'Sales Dashboard', preview: 'data:image/png;base64,SAVED' },
      ],
    })

    assert.equal(await hydrateArtefactPreviews(api, 'project-1', 'thread-a'), true)
    assert.equal(getArtefactPreview('thread-a', 'Sales Dashboard'), 'data:image/png;base64,SAVED')
  })

  it('reports nothing added for a thread that saved no thumbnails', async () => {
    const api = createPendingApi({
      'canvas.listArtefacts': async (): Promise<CanvasArtefactSummary[]> => [
        { title: 'No Thumbnail' },
      ],
    })

    assert.equal(await hydrateArtefactPreviews(api, 'project-1', 'thread-a'), false)
  })

  it('survives a canvas store it cannot read', async () => {
    const api = createPendingApi({
      'canvas.listArtefacts': (): Promise<CanvasArtefactSummary[]> =>
        Promise.reject(new Error('unreadable')),
    })

    assert.equal(await hydrateArtefactPreviews(api, 'project-1', 'thread-a'), false)
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
