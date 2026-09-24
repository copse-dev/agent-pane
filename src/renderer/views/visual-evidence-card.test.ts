import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { VisualEvidenceRef } from '@shared/types'
import { createVisualEvidenceSection } from './visual-evidence-card.ts'

function evidence(): VisualEvidenceRef {
  return {
    id: 'evidence-1',
    toolCallId: 'tool-1',
    kind: 'comparison',
    caption: 'The mobile toolbar no longer overlaps the editor',
    createdAt: Date.UTC(2026, 8, 22, 11, 30),
    assets: [
      {
        id: 'asset-before',
        label: 'Before',
        mimeType: 'image/png',
        width: 390,
        height: 844,
        capturedAt: Date.UTC(2026, 8, 22, 11, 28),
        dataUrl: 'data:image/png;base64,YmVmb3Jl',
        source: {
          kind: 'browser',
          viewId: 'view-1',
          title: 'Copse',
          url: 'https://example.test/settings',
        },
      },
      {
        id: 'asset-after',
        label: 'After',
        mimeType: 'image/png',
        width: 390,
        height: 844,
        capturedAt: Date.UTC(2026, 8, 22, 11, 29),
        dataUrl: 'data:image/png;base64,YWZ0ZXI=',
        source: {
          kind: 'browser',
          viewId: 'view-1',
          title: 'Copse',
          url: 'https://example.test/settings',
        },
      },
    ],
  }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('assistant visual evidence card', () => {
  it('renders a compact before/after disclosure with expandable full images', () => {
    const section = createVisualEvidenceSection([evidence()])
    assert.ok(section)
    document.body.append(section)

    const card = section.querySelector<HTMLDetailsElement>('.visual-evidence-card')
    assert.ok(card)
    assert.equal(card.open, false)
    assert.equal(card.dataset['toolCallId'], 'tool-1')
    assert.equal(
      section.querySelector('.visual-evidence-caption')?.textContent,
      'The mobile toolbar no longer overlaps the editor',
    )
    assert.equal(section.querySelector('.visual-evidence-kind')?.textContent, 'Before / After')
    assert.equal(section.querySelectorAll('.visual-evidence-thumbnails img').length, 2)
    assert.equal(section.querySelectorAll('.visual-evidence-image[tabindex="0"]').length, 2)
    assert.deepEqual(
      Array.from(section.querySelectorAll('.visual-evidence-label'), (node) => node.textContent),
      ['Before', 'After'],
    )
    assert.match(section.textContent, /390×844 · 2026-09-22 11:28 UTC/)
    assert.match(section.textContent, /https:\/\/example\.test\/settings/)
  })

  it('keeps a missing durable blob visible as unavailable evidence', () => {
    const item = evidence()
    item.kind = 'screenshot'
    const sourceAsset = item.assets[0]
    assert.ok(sourceAsset)
    item.assets = [
      {
        id: sourceAsset.id,
        label: sourceAsset.label,
        mimeType: sourceAsset.mimeType,
        width: sourceAsset.width,
        height: sourceAsset.height,
        capturedAt: sourceAsset.capturedAt,
        source: sourceAsset.source,
        unavailableReason: 'Evidence image is unavailable.',
      },
    ]
    const section = createVisualEvidenceSection([item])
    assert.ok(section)

    assert.equal(section.querySelectorAll('.visual-evidence-image').length, 0)
    assert.equal(
      section.querySelector('.visual-evidence-unavailable')?.getAttribute('role'),
      'status',
    )
    assert.match(section.textContent, /Evidence image is unavailable/)
  })
})
