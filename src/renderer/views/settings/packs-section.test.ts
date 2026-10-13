import '../../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import type { PluginSummary } from '@shared/types/plugins.ts'
import { createStore } from '@shared/store/store.ts'
import { createFakeApi } from '../../fake-api.test-support.ts'
import { qsRequired } from '../../dom/helpers.ts'
import { createPacksSection, pluginDisplayName } from './packs-section.ts'
import { customiseMarkup } from './customise-markup.ts'
import { experimentalMarkup } from './experimental-markup.ts'

it('renders friendly Copse names and Markdown, and moves an open disabled pack below enabled packs', async () => {
  document.body.innerHTML = ''
  const base = createFakeApi()
  const fixture = (await base.plugins.list()).plugins[0]
  assert.ok(fixture)
  let plugins: PluginSummary[] = [
    {
      ...fixture,
      id: 'copse.post-turn-review',
      name: 'copse.post-turn-review',
      enabled: true,
      stability: 'stable',
      description: 'A **review** after each turn.',
      settings: [{ id: 'reviewNotes', kind: 'boolean', title: 'Review notes', value: false }],
    },
    {
      ...fixture,
      id: 'copse.todos',
      name: 'copse.todos',
      enabled: true,
      stability: 'stable',
      settings: [],
    },
  ]
  assert.ok(plugins[0])
  assert.equal(pluginDisplayName(plugins[0]), 'Post turn review')
  const root = document.createElement('div')
  root.innerHTML = `<form><select name="model"><option value="gpt-4o">Chat</option></select>${customiseMarkup}${experimentalMarkup}</form>`
  document.body.append(root)
  const section = createPacksSection(
    root,
    {
      ...base,
      plugins: {
        ...base.plugins,
        list: async () => ({ plugins }),
        setEnabled: async (id, enabled) => {
          plugins = plugins.map((plugin) => (plugin.id === id ? { ...plugin, enabled } : plugin))
          return { plugins }
        },
      },
    },
    createStore(),
    () => 'customise',
    () => Promise.resolve(new AbortController().signal),
    () => {},
  )
  await section.refresh(new AbortController().signal)
  const row = qsRequired(root, '[data-plugin-id="copse.post-turn-review"]')
  assert.match(row.textContent, /Post turn review/)
  assert.match(row.textContent, /Copse/)
  assert.equal(qsRequired(row, '.plugin-row-desc strong').textContent, 'review')
  qsRequired<HTMLDetailsElement>(row, '.plugin-settings-fold').open = true
  const toggle = qsRequired<HTMLInputElement>(row, 'input[type="checkbox"]')
  toggle.checked = false
  toggle.dispatchEvent(new Event('change'))
  await setImmediate()
  await setImmediate()
  const order = [...root.querySelectorAll<HTMLElement>('#plugins-list .plugin-row')].map(
    (entry) => entry.dataset['pluginId'],
  )
  assert.deepEqual(order, ['copse.todos', 'copse.post-turn-review'])
})
