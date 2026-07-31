import { el } from '../dom/helpers.ts'
import { cx } from './cx.ts'

export interface UiFieldOptions {
  label: string
  control: HTMLElement
  hint?: string
  /** Extra classes for migration / screen-specific hooks. */
  className?: string
}

/**
 * Light-DOM labelled field. Assembles label → control → optional hint.
 * Registered as `<copse-ui-field>`.
 */
export class CopseUiField extends HTMLElement {
  static readonly tagName = 'copse-ui-field' as const
  static readonly observedAttributes = ['label', 'hint']

  connectedCallback(): void {
    this.ensureStructure()
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue) return
    if (!this.isConnected || !this.hasAttribute('data-ui-ready')) return
    if (name === 'label') {
      const labelEl = this.querySelector(':scope > .ui-field-label')
      if (labelEl) labelEl.textContent = newValue ?? ''
      return
    }
    if (name === 'hint') {
      const existing = this.querySelector(':scope > .ui-field-hint')
      if (newValue === null || newValue === '') {
        existing?.remove()
        return
      }
      if (existing) {
        existing.textContent = newValue
        return
      }
      this.append(el('span', { class: 'ui-field-hint field-hint' }, newValue))
    }
  }

  /** Public so factories can assemble structure before the node is connected. */
  ensureStructure(): void {
    if (this.hasAttribute('data-ui-ready')) return
    this.setAttribute('data-ui-ready', '')
    this.classList.add('ui-field')

    const label = this.getAttribute('label') ?? ''
    const hint = this.getAttribute('hint')
    const controls = [...this.childNodes]
    const labelEl = el('span', { class: 'ui-field-label' }, label)
    const children: Node[] = [labelEl, ...controls]
    if (hint) children.push(el('span', { class: 'ui-field-hint field-hint' }, hint))
    this.replaceChildren(...children)
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'copse-ui-field': CopseUiField
  }
}

function ensureDefined(): void {
  if (customElements.get(CopseUiField.tagName) === undefined) {
    customElements.define(CopseUiField.tagName, CopseUiField)
  }
}

export function uiField(opts: UiFieldOptions): CopseUiField {
  ensureDefined()
  const field = document.createElement(CopseUiField.tagName)
  field.setAttribute('label', opts.label)
  if (opts.hint !== undefined && opts.hint !== '') field.setAttribute('hint', opts.hint)
  field.className = cx('ui-field', opts.className)
  field.append(opts.control)
  if (!(field instanceof CopseUiField)) {
    throw new Error('copse-ui-field custom element failed to upgrade')
  }
  field.ensureStructure()
  return field
}
