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
      if (model.conversationLabel) {
        root.append(el('div', { class: 'footer-usage-popover-section' }, model.conversationLabel))
      }
      for (const entry of model.rows) root.append(row(entry, 'footer-usage-popover-row'))
      // Once subagents exist, cache/cost remain provider-reported whole-thread
      // figures. Keep them with the subagent and per-model accounting below an
      // explicit scope label instead of presenting them as part of the
      // subagent-excluded headline above.
      if (model.threadLabel) {
        root.append(el('div', { class: 'footer-usage-popover-divider' }))
        root.append(el('div', { class: 'footer-usage-popover-section' }, model.threadLabel))
        for (const entry of model.threadRows) root.append(row(entry, 'footer-usage-popover-row'))
      } else {
        for (const entry of model.threadRows) root.append(row(entry, 'footer-usage-popover-row'))
        if (model.subagentRow || model.modelRows.length > 0) {
          root.append(el('div', { class: 'footer-usage-popover-divider' }))
        }
      }
      if (model.subagentRow) {
        root.append(row(model.subagentRow, 'footer-usage-popover-row is-subagents'))
      }
      for (const entry of model.modelRows) {
        root.append(row(entry, 'footer-usage-popover-row is-model'))
      }
      if (model.note) root.append(el('div', { class: 'footer-usage-popover-note' }, model.note))
      if (model.freeNote) {
        root.append(el('div', { class: 'footer-usage-popover-note' }, model.freeNote))
      }
    },
    show(): void {
      if (hasContent) root.hidden = false
    },
    hide(): void {
      root.hidden = true
    },
  }
}
