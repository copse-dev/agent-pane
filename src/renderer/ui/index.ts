import { registerUiKit } from './register.ts'

export { cx } from './cx.ts'
export { CopseUiActions, uiActions, type UiActionsAlign, type UiActionsOptions } from './actions.ts'
export { CopseUiField, uiField, type UiFieldOptions } from './field.ts'
export {
  uiPaneTab,
  uiPaneTabsShell,
  type UiPaneTab,
  type UiPaneTabOptions,
  type UiPaneTabsShell,
  type UiPaneTabsShellOptions,
} from './pane-tabs.ts'
export { registerUiKit } from './register.ts'

// Ensure kit tags are defined whenever the barrel is imported.
registerUiKit()
