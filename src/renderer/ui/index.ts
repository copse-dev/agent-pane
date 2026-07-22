import { registerUiKit } from './register.ts'

export { cx } from './cx.ts'
export { uiButton, type UiButtonOptions, type UiButtonVariant } from './button.ts'
export {
  CopseUiActions,
  uiActions,
  type UiActionsAlign,
  type UiActionsOptions,
} from './actions.ts'
export { CopseUiField, uiField, type UiFieldOptions } from './field.ts'
export { registerUiKit } from './register.ts'

// Ensure kit tags are defined whenever the barrel is imported.
registerUiKit()
