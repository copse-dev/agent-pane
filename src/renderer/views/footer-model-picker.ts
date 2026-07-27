import type { ApiClient } from '../../preload/api.d.ts'
import { fetchModelOptions } from './model-options.ts'
import { mountModelPicker } from './model-picker.ts'

export interface FooterModelPickerOptions {
  /** When true, ACP agents are omitted (SSH workspaces). */
  isSshWorkspace?: () => boolean
  /** Called after the menu closes (e.g. return focus to the composer). */
  onClose?: () => void
}

// Composer adapter for the app-wide picker. The trigger stays compact while the
// shared menu provides the same search/group/keyboard experience as form fields.
export function mountFooterModelPicker(
  root: HTMLElement,
  api: ApiClient,
  getCurrent: () => string,
  onSelect: (model: string) => void,
  pickerOpts: FooterModelPickerOptions = {},
): { refresh: () => void; destroy: () => void } {
  const picker = mountModelPicker(
    root,
    getCurrent,
    (model) => {
      onSelect(model)
      void picker.refresh()
    },
    (current) =>
      fetchModelOptions(api, current, {
        sshWorkspace: pickerOpts.isSshWorkspace?.() === true,
      }),
    {
      variant: 'compact',
      enableShortcut: true,
      ariaLabel: 'Chat model',
      ...(pickerOpts.onClose ? { onClose: pickerOpts.onClose } : {}),
    },
  )

  return { refresh: () => void picker.refresh(), destroy: picker.destroy }
}
