import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { automationsPlugin } from '@copse/agent/plugins/automations-plugin.ts'
import { PluginRegistry } from '@copse/agent/plugins/plugin-registry.ts'
import { summarizePlugins } from '@copse/agent/plugins/plugin-summary.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { PluginsListResult } from '@shared/types/plugins.ts'
import { createStore } from '@shared/store/store.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { hasAutomationDialog, openAutomationDialog } from './automation-dialog.ts'

function fixture(): { store: AppStore; api: ApiClient; registry: PluginRegistry } {
  const registry = new PluginRegistry()
  registry.register(automationsPlugin)
  registry.disable(automationsPlugin.id)
  const base = createFakeApi()
  const list = (): Promise<PluginsListResult> =>
    Promise.resolve({ plugins: summarizePlugins(registry, () => undefined) })
  const api = {
    ...base,
    plugins: {
      ...base.plugins,
      list,
      setEnabled: (id: string, enabled: boolean): Promise<PluginsListResult> => {
        if (enabled) registry.enable(id)
        else registry.disable(id)
        return list()
      },
    },
  }
  const store = createStore({
    activeProjectId: 'project-1',
    projects: [{ id: 'project-1', path: '/workspace', name: 'Workspace' }],
  })
  return { store, api, registry }
}
const tick = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(async () => {
  document.querySelector<HTMLDialogElement>('#automation-dialog')?.close()
  await tick()
  document.body.replaceChildren()
})

describe('automation dialog', () => {
  it('requires the shipped plugin and its modal declaration, including while disabled', async () => {
    const { api } = fixture()
    const plugin = (await api.plugins.list()).plugins[0]
    assert.ok(plugin)
    assert.equal(hasAutomationDialog(plugin), true)
    assert.equal(hasAutomationDialog({ ...plugin, trust: 'user' }), false)
    assert.equal(hasAutomationDialog({ ...plugin, id: 'another-plugin' }), false)
    assert.equal(
      hasAutomationDialog({ ...plugin, contributions: { ...plugin.contributions, ui: [] } }),
      false,
    )
  })

  it('creates without Settings and preserves a draft when the plugin is enabled', async () => {
    const { store, api } = fixture()
    openAutomationDialog(store, api, { createNew: true })
    await tick()
    const dialog = document.querySelector<HTMLDialogElement>('#automation-dialog')
    assert.ok(dialog?.open)
    assert.equal(document.querySelector('#settings-dialog[open]'), null)
    assert.equal(dialog.querySelector<HTMLFormElement>('.automation-form')?.hidden, false)
    const name = dialog.querySelector<HTMLInputElement>('.automation-name-input')
    assert.ok(name)
    name.value = 'Draft I am still writing'
    dialog.querySelector<HTMLButtonElement>('.automation-plugin-toggle')?.click()
    await tick()
    assert.equal(name.value, 'Draft I am still writing')
    assert.match(dialog.textContent, /Automations plugin enabled/)
    openAutomationDialog(store, api)
    assert.equal(document.querySelectorAll('#automation-dialog').length, 1)
  })

  it('closes when the active project changes', async () => {
    const { store, api } = fixture()
    openAutomationDialog(store, api)
    await tick()
    store.setState({ activeProjectId: 'other' })
    store.emit('workspace_changed')
    assert.equal(
      document.querySelector<HTMLDialogElement>('#automation-dialog')?.open ?? false,
      false,
    )
  })

  it('shows a useful error if the plugin cannot be loaded', async () => {
    const { store, api } = fixture()
    api.plugins.list = (): Promise<PluginsListResult> =>
      Promise.reject(new Error('Plugin service unavailable'))
    openAutomationDialog(store, api)
    await tick()
    assert.match(
      document.querySelector('#automation-dialog')?.textContent ?? '',
      /Plugin service unavailable/,
    )
    assert.equal(document.querySelector('.automation-form'), null)
  })
})
