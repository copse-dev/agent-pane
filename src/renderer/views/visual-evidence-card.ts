import type { VisualEvidenceAsset, VisualEvidenceRef } from '@shared/types'
import { attachImageExpand } from '../attachments/image-expand.ts'
import { el } from '../dom/helpers.ts'
import { imageIcon } from '../dom/icons.ts'

function captureTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return 'Unknown capture time'
  try {
    return `${new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC`
  } catch {
    return 'Unknown capture time'
  }
}

function kindLabel(evidence: VisualEvidenceRef): string {
  return evidence.kind === 'comparison' ? 'Before / After' : 'Screenshot'
}

function sourceTitle(asset: VisualEvidenceAsset): string {
  return asset.source.title.trim() || asset.source.url
}

function thumbnail(asset: VisualEvidenceAsset, caption: string): HTMLElement {
  if (!asset.dataUrl) {
    return el(
      'div',
      { class: 'visual-evidence-thumbnail visual-evidence-thumbnail-unavailable' },
      el('span', {}, asset.label),
      el('span', {}, 'Unavailable'),
    )
  }
  const image = el('img', {
    class: 'visual-evidence-thumbnail',
    src: asset.dataUrl,
    alt: `${asset.label}: ${caption}`,
    loading: 'lazy',
  })
  return image
}

function evidenceFigure(asset: VisualEvidenceAsset, caption: string): HTMLElement {
  const media = asset.dataUrl
    ? ((): HTMLElement => {
        const image = el('img', {
          class: 'visual-evidence-image',
          src: asset.dataUrl,
          alt: `${asset.label}: ${caption}`,
          loading: 'lazy',
        })
        attachImageExpand(image, `${asset.label}: ${caption}`)
        return image
      })()
    : el(
        'div',
        { class: 'visual-evidence-unavailable', role: 'status' },
        imageIcon('ui-icon visual-evidence-unavailable-icon'),
        el('span', {}, asset.unavailableReason ?? 'Evidence image is unavailable.'),
      )

  return el(
    'figure',
    {
      class: 'visual-evidence-figure',
      'data-evidence-asset-id': asset.id,
      'data-available': asset.dataUrl ? 'true' : 'false',
    },
    el('div', { class: 'visual-evidence-label' }, asset.label),
    media,
    el(
      'figcaption',
      { class: 'visual-evidence-asset-meta' },
      el('span', { class: 'visual-evidence-source-title' }, sourceTitle(asset)),
      el('code', { class: 'visual-evidence-source-url' }, asset.source.url),
      el(
        'span',
        { class: 'visual-evidence-capture-meta' },
        `${String(asset.width)}×${String(asset.height)} · ${captureTime(asset.capturedAt)}`,
      ),
    ),
  )
}

/** Build the compact, expandable evidence collection for one assistant message. */
export function createVisualEvidenceSection(
  evidence: readonly VisualEvidenceRef[],
): HTMLElement | null {
  if (evidence.length === 0) return null
  const section = el('div', {
    class: 'message-visual-evidence',
    'aria-label': 'Visual evidence',
  })
  for (const item of evidence) {
    const summary = el(
      'summary',
      { class: 'visual-evidence-summary' },
      imageIcon('ui-icon visual-evidence-icon'),
      el(
        'span',
        { class: 'visual-evidence-heading' },
        el('span', { class: 'visual-evidence-eyebrow' }, 'Visual evidence'),
        el('span', { class: 'visual-evidence-caption' }, item.caption),
        el(
          'span',
          { class: 'visual-evidence-summary-meta' },
          `${String(item.assets.length)} ${item.assets.length === 1 ? 'capture' : 'captures'} · Browser`,
        ),
      ),
      el('span', { class: 'visual-evidence-kind' }, kindLabel(item)),
      el(
        'span',
        { class: 'visual-evidence-thumbnails', 'aria-hidden': 'true' },
        ...item.assets.map((asset) => thumbnail(asset, item.caption)),
      ),
    )
    const body = el(
      'div',
      {
        class: 'visual-evidence-body',
        'data-evidence-asset-count': String(item.assets.length),
      },
      ...item.assets.map((asset) => evidenceFigure(asset, item.caption)),
    )
    section.append(
      el(
        'details',
        {
          class: 'visual-evidence-card',
          'data-evidence-id': item.id,
          'data-evidence-kind': item.kind,
          'data-tool-call-id': item.toolCallId,
        },
        summary,
        body,
      ),
    )
  }
  return section
}
