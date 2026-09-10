import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { PluginSummary } from '@shared/types/plugins.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { el } from '../dom/helpers.ts'
import { closeIcon } from '../dom/icons.ts'
import { createAutomationPluginSettings } from './automation-plugin-settings.ts'
import { createOverlayDialog } from './dialog-shell.ts'
import { openAutomationSettings } from './settings-dialog.ts'

/** A shipped view is reachable only through its first-party plugin declaration. */
export function hasAutomationDialog(plugin: PluginSummary): boolean {
  return (
    plugin.id === AUTOMATIONS_PLUGIN_ID &&
    plugin.trust === 'first-party' &&
    plugin.contributions.ui.some(
      (ui) => ui.id === 'automation-manager' && ui.level === 3 && ui.slot === 'app-dialog',
    )
  )
}

/** The same project editor Settings mounts, with its own native modal shell. */
export function openAutomationDialog(
  store: AppStore,
  api: ApiClient,
  options: { projectId?: string; scheduleId?: string; createNew?: boolean } = {},
): void {
  if (document.querySelector('#automation-dialog[open]')) return
  const activeProjectId = store.getState().activeProjectId
  const projectId = options.projectId ?? activeProjectId
  const { dialog, open, close } = createOverlayDialog({ id: 'automation-dialog' })
  dialog.setAttribute('aria-labelledby', 'automation-dialog-title')
  const closeButton = el(
    'button',
    {
      type: 'button',
      class: 'ui-btn ui-btn-ghost',
      'aria-label': 'Close automations',
    },
    closeIcon(),
  )
  closeButton.addEventListener('click', close)
  const header = el(
    'header',
    { class: 'automation-dialog-header' },
    el('h2', { id: 'automation-dialog-title' }, 'Automations'),
    closeButton,
  )
  const body = el('div', { class: 'automation-dialog-body' })
  const status = el('p', { class: 'automation-notice', role: 'status' }, 'Loading automations…')
  body.append(status)
  dialog.append(header, body)
  // Do not let a project change behind the modal redirect an in-progress edit.
  const unsubscribe = store.on('workspace_changed', () => {
    if (store.getState().activeProjectId !== activeProjectId) close()
  })
  dialog.addEventListener(
    'close',
    () => {
      unsubscribe()
      dialog.remove()
    },
    { once: true },
  )
  open()

  function render(plugin: PluginSummary): void {
    if (!dialog.open) return
    let enabled = plugin.enabled
    const editor = createAutomationPluginSettings(
      store,
      api,
      enabled,
      options.scheduleId,
      options.createNew,
      projectId,
    )
    const toggle = el(
      'button',
      {
        type: 'button',
        class: 'ui-btn ui-btn-secondary automation-plugin-toggle',
      },
      plugin.enabled ? 'Disable plugin' : 'Enable automations',
    )
    const label = el(
      'span',
      {},
      enabled ? 'Automations plugin enabled' : 'Automations plugin disabled',
    )
    const settings = el(
      'button',
      { type: 'button', class: 'ui-btn ui-btn-ghost' },
      'Plugin settings',
    )
    settings.addEventListener('click', () => {
      close()
      openAutomationSettings()
    })
    const state = el('div', { class: 'automation-dialog-plugin' }, label, settings, toggle)
    toggle.addEventListener('click', () => {
      toggle.disabled = true
      void api.plugins
        .setEnabled(plugin.id, !enabled)
        .then((result) => {
          const updated = result.plugins.find(hasAutomationDialog)
          if (!updated) throw new Error('The automations plugin is no longer available.')
          enabled = updated.enabled
          editor.setPluginEnabled(enabled)
          store.emit('settings_changed')
          label.textContent = enabled ? 'Automations plugin enabled' : 'Automations plugin disabled'
          toggle.textContent = enabled ? 'Disable plugin' : 'Enable automations'
          toggle.disabled = false
        })
        .catch((error: unknown) => {
          status.textContent =
            error instanceof Error ? error.message : 'Could not update the plugin.'
          toggle.disabled = false
        })
    })
    status.textContent = ''
    body.replaceChildren(state, status, editor)
  }

  void api.plugins
    .list()
    .then((result) => {
      if (!dialog.open) return
      const plugin = result.plugins.find(hasAutomationDialog)
      if (!plugin) {
        status.textContent = 'The automations plugin is not available.'
        return
      }
      render(plugin)
    })
    .catch((error: unknown) => {
      status.textContent = error instanceof Error ? error.message : 'Could not load automations.'
    })
}
