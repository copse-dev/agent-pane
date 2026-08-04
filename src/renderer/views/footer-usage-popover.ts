import type {
  FooterUsageTooltipModel,
  FooterUsageTooltipRow,
} from '@shared/usage/footer-usage-tooltip.ts'
import { clear, el } from '../dom/helpers.ts'

export interface FooterUsagePopover {
  root: HTMLElement
  /** Rebuild the contents; `null` empties it and keeps it hidden. */
  render: (model: FooterUsageTooltipModel | null) => void
  show: () => void
  hide: () => void
}

function row(entry: FooterUsageTooltipRow, className: string): HTMLElement {
  return el(
    'div',
    { class: className },
    el('span', { class: 'footer-usage-popover-name' }, entry.label),
    el('span', { class: 'footer-usage-popover-value' }, entry.value),
  )
}

/**
 * Hover tooltip for the footer token counter. Mirrors the context-wheel popover
 * (same anchor-positioned footer chrome) but lists in/out tokens and cost.
 */
export function createFooterUsagePopover(): FooterUsagePopover {
  const root = el('div', { class: 'footer-usage-popover', role: 'tooltip', hidden: true })
  let hasContent = false

  return {
    root,
    render(model): void {
      clear(root)
      hasContent = model !== null
      if (!model) {
        root.hidden = true
        return
      }
      root.append(el('div', { class: 'footer-usage-popover-header' }, model.header))
      for (const entry of model.rows) root.append(row(entry, 'footer-usage-popover-row'))
      if (model.modelRows.length > 0) {
        root.append(el('div', { class: 'footer-usage-popover-divider' }))
        for (const entry of model.modelRows) {
          root.append(row(entry, 'footer-usage-popover-row is-model'))
        }
      }
      if (model.note) root.append(el('div', { class: 'footer-usage-popover-note' }, model.note))
    },
    show(): void {
      if (hasContent) root.hidden = false
    },
    hide(): void {
      root.hidden = true
    },
  }
}
