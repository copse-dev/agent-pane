import { CopseUiActions } from './actions.ts'
import { CopseUiField } from './field.ts'

let registered = false

/** Idempotent custom-element registration for the renderer UI kit. */
export function registerUiKit(): void {
  if (registered) return
  registered = true
  if (customElements.get(CopseUiActions.tagName) === undefined) {
    customElements.define(CopseUiActions.tagName, CopseUiActions)
  }
  if (customElements.get(CopseUiField.tagName) === undefined) {
    customElements.define(CopseUiField.tagName, CopseUiField)
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'copse-ui-actions': CopseUiActions
    'copse-ui-field': CopseUiField
  }
}
