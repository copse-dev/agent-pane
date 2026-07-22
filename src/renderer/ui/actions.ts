import { cx } from './cx.ts'

export type UiActionsAlign = 'start' | 'end' | 'stretch'

export interface UiActionsOptions {
  align?: UiActionsAlign
  /** Extra classes for migration / screen-specific hooks. */
  className?: string
}

/**
 * Light-DOM action row. Children are typically {@link uiButton} results.
 * Registered as `<copse-ui-actions>`.
 */
export class CopseUiActions extends HTMLElement {
  static readonly tagName = 'copse-ui-actions' as const

  connectedCallback(): void {
    this.classList.add('ui-actions')
    const align = this.getAttribute('align')
    if (align === 'start' || align === 'end' || align === 'stretch') {
      this.dataset['align'] = align
    } else if (!this.dataset['align']) {
      this.dataset['align'] = 'end'
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'copse-ui-actions': CopseUiActions
  }
}

function ensureDefined(): void {
  if (customElements.get(CopseUiActions.tagName) === undefined) {
    customElements.define(CopseUiActions.tagName, CopseUiActions)
  }
}

function isUiActionsOptions(value: unknown): value is UiActionsOptions {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof HTMLElement) &&
    ('align' in value || 'className' in value || Object.keys(value).length === 0)
  )
}

export function uiActions(...buttons: HTMLElement[]): CopseUiActions
export function uiActions(...args: [...HTMLElement[], UiActionsOptions]): CopseUiActions
export function uiActions(...args: Array<HTMLElement | UiActionsOptions>): CopseUiActions {
  ensureDefined()
  const last = args.at(-1)
  const hasOptions = last !== undefined && isUiActionsOptions(last)
  const options: UiActionsOptions = hasOptions ? last : {}
  const buttons = (hasOptions ? args.slice(0, -1) : args).filter(
    (node): node is HTMLElement => node instanceof HTMLElement,
  )

  const row = document.createElement(CopseUiActions.tagName)
  const align = options.align ?? 'end'
  row.setAttribute('align', align)
  row.dataset['align'] = align
  row.className = cx('ui-actions', options.className)
  row.append(...buttons)
  return row
}
