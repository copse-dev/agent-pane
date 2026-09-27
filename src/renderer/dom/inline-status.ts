import { setInlineMarkdown } from '../markdown/inline-markdown.ts'
import { el } from './helpers.ts'
import { checkIcon, closeIcon, dotIcon, minusIcon, spinnerIcon, warningIcon } from './icons.ts'

export type InlineStatusKind = 'ok' | 'error' | 'pending' | 'filled' | 'warn' | 'idle'

function statusIcon(kind: InlineStatusKind): SVGSVGElement {
  switch (kind) {
    case 'ok':
      return checkIcon('ui-icon ui-icon-sm')
    case 'error':
      return closeIcon('ui-icon ui-icon-sm')
    case 'pending':
      // In-progress marker; `.ui-inline-status[data-status-kind='pending'] .ui-icon` spins.
      return spinnerIcon('ui-icon ui-icon-sm')
    case 'filled':
      return dotIcon('ui-icon ui-icon-sm')
    case 'warn':
      return warningIcon('ui-icon ui-icon-sm')
    case 'idle':
      // Settled absence (Not loaded / not found) — must not share the pending spinner.
      return minusIcon('ui-icon ui-icon-sm')
  }
}

export function inlineStatus(kind: InlineStatusKind, text: string): HTMLSpanElement {
  return el(
    'span',
    { class: 'ui-inline-status', 'data-status-kind': kind },
    statusIcon(kind),
    el('span', { class: 'ui-inline-status-text' }, text),
  )
}

export function setInlineStatus(target: Element, kind: InlineStatusKind, text: string): void {
  target.replaceChildren(inlineStatus(kind, text))
}

/**
 * Like {@link setInlineStatus}, but the text may name commands or environment
 * variables in backticks, which render as inline code rather than delimiters.
 */
export function setInlineStatusMarkdown(
  target: Element,
  kind: InlineStatusKind,
  source: string,
): void {
  const text = el('span', { class: 'ui-inline-status-text' })
  setInlineMarkdown(text, source)
  target.replaceChildren(
    el('span', { class: 'ui-inline-status', 'data-status-kind': kind }, statusIcon(kind), text),
  )
}
