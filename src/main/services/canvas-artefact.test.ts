import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { artefactTitleFromUri, toCanvasArtefact } from './canvas-artefact.ts'

describe('artefactTitleFromUri', () => {
  it('title-cases the last path segment', () => {
    assert.equal(artefactTitleFromUri('ui://canvas/sales-dashboard'), 'Sales Dashboard')
    assert.equal(artefactTitleFromUri('ui://component/my_widget'), 'My Widget')
  })

  it('falls back to "Artefact" for empty/odd URIs', () => {
    assert.equal(artefactTitleFromUri(''), 'Artefact')
    assert.equal(artefactTitleFromUri('ui://'), 'Artefact')
  })
})

describe('toCanvasArtefact', () => {
  it('maps a UI resource to a renderer artefact', () => {
    assert.deepEqual(
      toCanvasArtefact({ uri: 'ui://canvas/demo', mimeType: 'text/html', text: '<h1>hi</h1>' }),
      { title: 'Demo', mimeType: 'text/html', body: '<h1>hi</h1>' },
    )
  })
})
