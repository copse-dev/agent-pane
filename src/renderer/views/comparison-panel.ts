import { el } from '../dom/helpers.ts'
import { searchIcon } from '../dom/icons.ts'
import type { ModelComparison } from '@shared/types'
import { renderMarkdown, sanitizeRenderedMarkdown } from '@copse/streaming-markdown'
import { annotateFileReferences } from '../markdown/file-links.ts'
import type { ApiClient } from '../../preload/api.d.ts'

function statusLabel(status: ModelComparison['status']): string {
  switch (status) {
    case 'running':
      return 'Comparing models…'
    case 'error':
      return 'Comparison failed'
    default:
      return 'Model comparison'
  }
}

/** A titled markdown block (one reviewer column, or the judge synthesis). */
function markdownBlock(
  className: string,
  title: string,
  body: string,
  api: ApiClient,
): HTMLElement {
  const block = el('div', { class: className })
  block.append(el('div', { class: 'comparison-panel-col-title' }, title))
  const md = el('div', { class: 'comparison-panel-md message-text' })
  md.innerHTML = sanitizeRenderedMarkdown(renderMarkdown(body || '(no output)'))
  void annotateFileReferences(md, api)
  block.append(md)
  return block
}

/** Card summarising a two-model diff comparison (reviews A/B + judge synthesis). */
export function createComparisonCardEl(comparison: ModelComparison, api: ApiClient): HTMLElement {
  const panel = el('div', {
    class: `comparison-panel comparison-panel-${comparison.status}`,
    'data-status': comparison.status,
  })

  const header = el('div', { class: 'comparison-panel-header' })
  header.append(
    el(
      'span',
      { class: 'comparison-panel-icon', 'aria-hidden': 'true' },
      searchIcon('ui-icon ui-icon-sm'),
    ),
    el('span', { class: 'comparison-panel-title' }, statusLabel(comparison.status)),
  )
  if (comparison.cost) {
    header.append(el('span', { class: 'comparison-panel-cost' }, comparison.cost))
  }
  panel.append(header)

  if (comparison.status === 'running') return panel

  if (comparison.status === 'error') {
    panel.append(
      el(
        'div',
        { class: 'comparison-panel-error message-text' },
        comparison.error || 'Comparison failed.',
      ),
    )
    return panel
  }

  const columns = el('div', { class: 'comparison-panel-columns' })
  columns.append(
    markdownBlock('comparison-panel-col', comparison.models.a, comparison.reviewA, api),
    markdownBlock('comparison-panel-col', comparison.models.b, comparison.reviewB, api),
  )
  panel.append(columns)
  panel.append(
    markdownBlock(
      'comparison-panel-synthesis',
      `Comparison — ${comparison.models.judge}`,
      comparison.synthesis,
      api,
    ),
  )
  return panel
}
