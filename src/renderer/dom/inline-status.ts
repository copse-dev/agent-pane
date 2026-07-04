import { el } from './helpers.ts'
import { checkIcon, circleIcon, closeIcon, dotIcon, warningIcon } from './icons.ts'

export type InlineStatusKind = 'ok' | 'error' | 'pending' | 'filled' | 'warn'

function statusIcon(kind: InlineStatusKind): SVGSVGElement {
  switch (kind) {
    case 'ok':
      return checkIcon('ui-icon ui-icon-sm')
    case 'error':
      return closeIcon('ui-icon ui-icon-sm')
    case 'pending':
      return circleIcon('ui-icon ui-icon-sm')
    case 'filled':
      return dotIcon('ui-icon ui-icon-sm')
    case 'warn':
      return warningIcon('ui-icon ui-icon-sm')
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
