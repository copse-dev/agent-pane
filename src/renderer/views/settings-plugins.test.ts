// Settings → Plugins list rendering (P3 of docs/plans/hooks-and-feature-packs.md).
//
// The plugin list is the "about:addons" of Copse: one row per registered plugin
// with an enable/disable toggle that flips the shared PluginRegistry atomically
// (P1 contract), an enumeration of what the plugin contributes, and a generic
// settings block rendered from the manifest schema. This spec exercises the
// component in a happy-dom shim so the assertions can inspect the DOM the same
// way the WDIO e2e will (with real Chromium doing full layout).
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore, type AppStore } from '@shared/store/store.ts'
import type { PluginSummary, PluginsListResult } from '@shared/types/plugins.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountSettingsDialog } from './settings-dialog.ts'
import { createPendingApi } from '../fake-api.test-support.ts'
import { isDynamicModel } from '@copse/llm/dynamic-model.ts'

/** Records the last mutation the stub received so click-through assertions can inspect it. */
interface StubApiSpy {
  lastSetEnabled: { id: string; enabled: boolean } | null
  lastSetSetting: { id: string; key: string; value: unknown } | null
  addSourceCalls: number
}

function stubApi(initial: PluginsListResult, spy: StubApiSpy): ApiClient {
  let current = initial
  return createPendingApi({
    'instructions.list': () => Promise.resolve([]),
    'cursorRules.list': () => Promise.resolve([]),
    'skills.list': () => Promise.resolve([]),
    'cursorPlugins.list': () => Promise.resolve([]),
    'hooks.list': () => Promise.resolve({ hooks: [], warnings: [] }),
    'plugins.list': () => Promise.resolve(current),
    'plugins.setEnabled': (id: string, enabled: boolean) => {
      spy.lastSetEnabled = { id, enabled }
      current = {
        plugins: current.plugins.map((p) => (p.id === id ? { ...p, enabled } : p)),
      }
      return Promise.resolve(current)
    },
    'plugins.setSetting': (id: string, key: string, value: unknown) => {
      spy.lastSetSetting = { id, key, value }
      current = {
        plugins: current.plugins.map((p) => {
          if (p.id !== id) return p
          return {
            ...p,
            settings: p.settings.map((f) => {
              if (f.id !== key) return f
              if (
                typeof value === 'boolean' ||
                typeof value === 'number' ||
                typeof value === 'string'
              ) {
                return { ...f, value }
              }
              return f
            }),
          }
        }),
      }
      return Promise.resolve(current)
    },
    'plugins.addSource': () => {
      spy.addSourceCalls += 1
      return Promise.resolve(current)
    },
  })
}

const demoPlugin: PluginSummary = {
  id: 'copse.demo',
  trust: 'first-party',
  stability: 'stable',
  name: 'copse.demo',
  version: '1.2.3',
  description: 'A demonstration plugin.',
  enabled: true,
  contributions: {
    toolNames: ['demo_tool'],
    modelRoutes: [],
    browserOrigins: [],
    blockingHooks: [{ id: 'demo-hook', event: 'turnStart' }],
    asyncHooks: [],
    commandHooks: [],
    promptBlocks: [{ id: 'demo-steer', trust: 'trusted' }],
    ui: [{ id: 'demo-panel', level: 2, slot: 'sidebar', title: 'Demo panel', panelKind: 'list' }],
    followUps: [],
    capabilities: [],
    permissions: [],
    storageNamespace: 'copse.demo',
  },
  settings: [
    {
      id: 'budget',
      kind: 'number',
      title: 'Budget per turn',
      value: 3,
      default: 3,
    },
    {
      id: 'label',
      kind: 'string',
      title: 'Label',
      value: 'hi',
      default: 'hi',
    },
  ],
}

const modelFieldPlugin: PluginSummary = {
  id: 'copse.model-demo',
  trust: 'first-party',
  stability: 'stable',
  name: 'copse.model-demo',
  enabled: true,
  contributions: {
    toolNames: [],
    modelRoutes: [],
    browserOrigins: [],
    blockingHooks: [],
    asyncHooks: [],
    commandHooks: [],
    promptBlocks: [],
    ui: [],
    followUps: [],
    capabilities: [],
    permissions: [],
  },
  settings: [
    {
      id: 'advisorModel',
      kind: 'model',
      title: 'Advisor model',
      value: 'claude-opus-4-8',
      default: 'claude-opus-4-8',
    },
  ],
}

const disabledUserPlugin: PluginSummary = {
  id: 'sample.user',
  trust: 'user',
  stability: 'experimental',
  name: 'sample.user',
  enabled: false,
  contributions: {
    toolNames: [],
    modelRoutes: [],
    browserOrigins: [],
    blockingHooks: [],
    asyncHooks: [],
    commandHooks: [{ event: 'toolGate', command: './guard.sh' }],
    promptBlocks: [],
    ui: [],
    followUps: [],
    capabilities: [],
    permissions: [],
  },
  settings: [],
}

const selectedToolPlugin: PluginSummary = {
  id: 'personal.local-model',
  trust: 'user',
  stability: 'experimental',
  name: 'personal.local-model',
  version: '0.1.0',
  description: 'A personal local model route.',
  enabled: false,
  source: {
    kind: 'directory',
    path: '/Users/example/private-plugins/personal.local-model',
    contentHash: `sha256:${'a'.repeat(64)}`,
  },
  contributions: {
    toolNames: ['ask_local_model'],
    modelRoutes: [
      {
        id: 'reference-judge',
        label: 'Reference judge',
        group: 'Personal models',
        description: 'A second-opinion model.',
        supportsImages: true,
      },
    ],
    browserOrigins: ['https://example.test'],
    blockingHooks: [],
    asyncHooks: [],
    commandHooks: [],
    promptBlocks: [{ id: 'local-steering', trust: 'untrusted' }],
    ui: [],
    followUps: [],
    capabilities: [],
    permissions: [],
    storageNamespace: 'personal.local-model',
  },
  settings: [],
}

async function openPlugins(
  initial: PluginsListResult,
  spy: StubApiSpy,
  store: AppStore = createStore(),
): Promise<HTMLElement> {
  document.body.innerHTML = ''
  mountSettingsDialog(store, stubApi(initial, spy))
  const btn = document.querySelector<HTMLButtonElement>(
    '.settings-nav-btn[data-section="customise"]',
  )
  assert.ok(btn)
  btn.click()
  // refreshPlugins() awaits api.plugins.list — let the microtask queue drain.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const list = document.getElementById('plugins-list')
  assert.ok(list)
  return list
}

/** The Plugins fieldset within Customise — the list's own prose lives here. */
function pluginsFieldset(): HTMLElement {
  const list = document.getElementById('plugins-list')
  assert.ok(list)
  const fieldset = list.closest('fieldset')
  assert.ok(fieldset)
  return fieldset
}

describe('settings → plugins list', () => {
  let spy: StubApiSpy

  beforeEach(() => {
    document.body.innerHTML = ''
    spy = {
      lastSetEnabled: null,
      lastSetSetting: null,
      addSourceCalls: 0,
    }
  })

  it('renders a nav button and empty state', async () => {
    const list = await openPlugins({ plugins: [] }, spy)
    const btn = document.querySelector('.settings-nav-btn[data-section="customise"]')
    assert.ok(btn)
    assert.match(btn.textContent, /Customise/)
    assert.match(list.textContent, /No plugins installed\./)
  })

  it('describes plugins without internal design-doc leaks, linking the add-a-plugin guide', async () => {
    await openPlugins({ plugins: [] }, spy)
    // Plugins are a fieldset within Customise, so the prose that has to stay
    // free of design-doc vocabulary is the fieldset's, not the section's.
    const desc = pluginsFieldset().querySelector('.settings-fieldset-desc')
    assert.ok(desc)
    assert.doesNotMatch(desc.textContent, /decision\s*17/i)
    assert.doesNotMatch(
      desc.innerHTML,
      /<code>\s*docs\/(?:plugins|adding-a-plugin)\.md\s*<\/code>/i,
    )
    const docsLink = desc.querySelector<HTMLAnchorElement>(
      'a[href="https://github.com/copse-dev/agent-pane/blob/main/docs/adding-a-plugin.md"]',
    )
    assert.ok(docsLink)
    assert.equal(docsLink.target, '_blank')
    assert.match(docsLink.rel, /noopener/)
    assert.match(docsLink.textContent, /how to add a plugin/i)
  })

  it('renders one row per plugin with trust and stability before enablement', async () => {
    const list = await openPlugins({ plugins: [demoPlugin, disabledUserPlugin] }, spy)
    const rows = list.querySelectorAll('.plugin-row')
    assert.equal(rows.length, 2)

    const first = rows[0]
    assert.ok(first)
    assert.equal(first.getAttribute('data-plugin-id'), 'copse.demo')
    assert.equal(first.getAttribute('data-enabled'), 'true')
    // First-party plugin name is presented display-friendly (sentence-case,
    // `copse.` prefix stripped) and the trust badge reads "Copse".
    assert.equal(first.querySelector('.plugin-name')?.textContent, 'Demo')
    assert.equal(first.querySelector('.plugin-version')?.textContent, '1.2.3')
    assert.equal(first.querySelector('.plugin-badge-first-party')?.textContent, 'Copse')
    assert.equal(first.querySelector('.plugin-badge-stable')?.textContent, 'stable')
    const toggle = first.querySelector<HTMLInputElement>('input.plugin-toggle-input')
    assert.ok(toggle)
    assert.equal(toggle.type, 'checkbox')
    assert.equal(toggle.checked, true)

    const second = rows[1]
    assert.ok(second)
    assert.equal(second.getAttribute('data-enabled'), 'false')
    assert.ok(second.classList.contains('plugin-row-disabled'))
    assert.equal(second.querySelector('.plugin-badge-user')?.textContent, 'User')
    assert.equal(second.querySelector('.plugin-badge-experimental')?.textContent, 'experimental')
    assert.equal(
      second.querySelector<HTMLInputElement>('input.plugin-toggle-input')?.checked,
      false,
    )
  })

  it('sentence-cases first-party plugin names and keeps acronyms uppercase', async () => {
    // Capitalising every word turned `copse.pii-redaction` into "Pii redaction"
    // and `copse.ci-investigator` into "Ci investigator" — the id transformation
    // showing through as user-facing copy. Only the lead word is capitalised,
    // and known acronyms stay whole.
    const cases: readonly (readonly [string, string])[] = [
      ['copse.todos', 'Todos'],
      ['copse.long-horizon-tasks', 'Long horizon tasks'],
      ['copse.post-turn-review', 'Post turn review'],
      ['copse.pii-redaction', 'PII redaction'],
      ['copse.ci-investigator', 'CI investigator'],
      ['copse.okf-memories', 'OKF memories'],
      ['copse.mcp-ui-canvas', 'MCP UI canvas'],
    ]
    for (const [id, expected] of cases) {
      const list = await openPlugins({ plugins: [{ ...demoPlugin, id, name: id }] }, spy)
      const row = list.querySelector(`[data-plugin-id="${id}"]`)
      assert.ok(row, `expected a row for ${id}`)
      assert.equal(row.querySelector('.plugin-name')?.textContent, expected)
    }
  })

  it('leaves a user plugin name exactly as authored', async () => {
    // The sentence-casing is a first-party affordance for `copse.<kebab>` ids.
    // A user plugin ships its own human name and must survive verbatim.
    const list = await openPlugins(
      { plugins: [{ ...demoPlugin, trust: 'user', id: 'acme.PII Tools', name: 'acme.PII Tools' }] },
      spy,
    )
    const row = list.querySelector('[data-plugin-id="acme.PII Tools"]')
    assert.ok(row)
    assert.equal(row.querySelector('.plugin-name')?.textContent, 'acme.PII Tools')
  })

  it('shows selected-directory provenance and ordinary plugin controls', async () => {
    const list = await openPlugins({ plugins: [selectedToolPlugin] }, spy)
    const row = list.querySelector<HTMLElement>('[data-plugin-id="personal.local-model"]')
    assert.ok(row)
    assert.equal(row.classList.contains('plugin-row-disabled'), true)
    assert.equal(row.querySelector('.plugin-badge-user')?.textContent, 'User')
    assert.equal(row.querySelector<HTMLInputElement>('.plugin-toggle-input')?.disabled, false)
    assert.match(row.textContent, /executable behaviors run in isolation/i)
    assert.match(row.textContent, /sha256:a{64}/)
    assert.match(row.textContent, /Models × 1/)
    assert.match(row.textContent, /Browser origins × 1/)
  })

  it('opens the host-owned plugin chooser from Settings', async () => {
    await openPlugins({ plugins: [] }, spy)
    const add = document.querySelector<HTMLButtonElement>('#plugins-add-btn')
    assert.ok(add)
    add.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(spy.addSourceCalls, 1)
  })

  it('enumerates tools / hooks / prompt / UI as chips with counts', async () => {
    const list = await openPlugins({ plugins: [demoPlugin] }, spy)
    const chips = list.querySelectorAll('.plugin-chip')
    const chipTexts = Array.from(chips).map((el) => el.textContent)
    assert.deepEqual(chipTexts, ['Tools × 1', 'Hooks × 1', 'Prompt blocks × 1', 'UI × 1'])
  })

  it('enumerates a capability-only plugin as a Capabilities chip', async () => {
    const capabilityPlugin: PluginSummary = {
      id: 'copse.mcp-ui-canvas',
      trust: 'first-party',
      stability: 'experimental',
      name: 'copse.mcp-ui-canvas',
      enabled: false,
      contributions: {
        toolNames: [],
        modelRoutes: [],
        browserOrigins: [],
        blockingHooks: [],
        asyncHooks: [],
        commandHooks: [],
        promptBlocks: [],
        ui: [],
        followUps: [],
        capabilities: [{ name: 'mcp-ui-canvas', title: 'MCP-UI canvas rendering' }],
        permissions: [],
      },
      settings: [],
    }
    const list = await openPlugins({ plugins: [capabilityPlugin] }, spy)
    const chipTexts = Array.from(list.querySelectorAll('.plugin-chip')).map((el) => el.textContent)
    assert.deepEqual(chipTexts, ['Capabilities × 1'])
    // A capability-only plugin contributes something — no skeleton note.
    assert.doesNotMatch(list.textContent, /Contributes nothing yet/)
  })

  it('enumerates a declared permission / sandbox relaxation as a Permissions chip', async () => {
    const permissionPlugin: PluginSummary = {
      id: 'copse.background-tasks',
      trust: 'first-party',
      stability: 'experimental',
      name: 'copse.background-tasks',
      enabled: false,
      contributions: {
        toolNames: ['run_background'],
        modelRoutes: [],
        browserOrigins: [],
        blockingHooks: [],
        asyncHooks: [],
        commandHooks: [],
        promptBlocks: [],
        ui: [],
        followUps: [],
        capabilities: [],
        permissions: [{ name: 'loopback-bind', title: 'Bind a loopback port', scope: 'project' }],
      },
      settings: [],
    }
    const list = await openPlugins({ plugins: [permissionPlugin] }, spy)
    const chipTexts = Array.from(list.querySelectorAll('.plugin-chip')).map((el) => el.textContent)
    assert.deepEqual(chipTexts, ['Tools × 1', 'Permissions × 1'])
  })

  it('shows a "contributes nothing" note for skeleton plugins', async () => {
    const skeleton: PluginSummary = {
      ...demoPlugin,
      id: 'copse.skeleton',
      contributions: {
        toolNames: [],
        modelRoutes: [],
        browserOrigins: [],
        blockingHooks: [],
        asyncHooks: [],
        commandHooks: [],
        promptBlocks: [],
        ui: [],
        followUps: [],
        capabilities: [],
        permissions: [],
      },
      settings: [],
    }
    const list = await openPlugins({ plugins: [skeleton] }, spy)
    assert.match(list.textContent, /Contributes nothing yet/)
  })

  it('renders manifest settings fields with current values', async () => {
    const list = await openPlugins({ plugins: [demoPlugin] }, spy)
    const fields = list.querySelectorAll('.plugin-setting-field')
    assert.equal(fields.length, 2)
    const numberInput = list.querySelector<HTMLInputElement>('.plugin-setting-number')
    assert.ok(numberInput)
    assert.equal(numberInput.value, '3')
    const stringInput = list.querySelector<HTMLInputElement>('.plugin-setting-string')
    assert.ok(stringInput)
    assert.equal(stringInput.value, 'hi')
  })

  it('renders a model setting field with the shared searchable picker', async () => {
    const list = await openPlugins({ plugins: [modelFieldPlugin] }, spy)
    const modelSelect = list.querySelector<HTMLSelectElement>('.plugin-setting-model')
    assert.ok(modelSelect, 'a model field must retain its form-owned select')
    assert.equal(modelSelect.tagName, 'SELECT')
    assert.equal(modelSelect.dataset['settingKey'], 'advisorModel')
    assert.ok(list.querySelector('.model-picker-field'))
    assert.ok(list.querySelector('.model-picker-filter'))
    // It is not misrendered as the plain string/enum inputs.
    assert.equal(list.querySelector('.plugin-setting-string'), null)
    assert.equal(list.querySelector('.plugin-setting-enum'), null)
  })

  it('offers dynamic selections only, plus the pinned value already stored', async () => {
    const list = await openPlugins({ plugins: [modelFieldPlugin] }, spy)
    // The option list is local (no catalogue fetch), so one microtask drain is
    // enough for the picker to render it.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const labels = [...list.querySelectorAll('.model-picker-option')].map((el) =>
      el.textContent.trim(),
    )
    assert.ok(labels.length > 0, 'the model field must render its options')
    assert.ok(
      labels.some((label) => label.startsWith('Best value')),
      `expected a dynamic rule among ${JSON.stringify(labels)}`,
    )
    assert.ok(
      labels.some((label) => label.includes('Advisor')),
      'roles must be selectable',
    )
    // Values, not labels, are what gets stored: every option is a rule apart
    // from the id already saved, which stays reachable so nothing silently
    // changes under the user.
    const select = list.querySelector<HTMLSelectElement>('.plugin-setting-model')
    assert.ok(select)
    const values = [...select.options].map((option) => option.value)
    assert.deepEqual(
      values.filter((value) => !isDynamicModel(value)),
      ['claude-opus-4-8'],
    )
    assert.equal(
      labels.filter((label) => label.endsWith('(pinned)')).length,
      1,
      `expected exactly one pinned row in ${JSON.stringify(labels)}`,
    )
  })

  it('editing a model field persists the chosen id via plugins:setSetting', async () => {
    const list = await openPlugins({ plugins: [modelFieldPlugin] }, spy)
    const modelSelect = list.querySelector<HTMLSelectElement>('.plugin-setting-model')
    assert.ok(modelSelect)
    // The live catalogue is fetched async (and never resolves under the stub api),
    // so add the target option ourselves before selecting it — the change handler
    // reads select.value regardless of how the option got there.
    const option = document.createElement('option')
    option.value = 'lmstudio:qwen3-32b'
    option.textContent = 'qwen3-32b'
    modelSelect.append(option)
    modelSelect.value = 'lmstudio:qwen3-32b'
    modelSelect.dispatchEvent(new Event('change'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(spy.lastSetSetting, {
      id: 'copse.model-demo',
      key: 'advisorModel',
      value: 'lmstudio:qwen3-32b',
    })
  })

  it('toggling calls plugins:setEnabled with the flipped state', async () => {
    const list = await openPlugins({ plugins: [demoPlugin] }, spy)
    const toggle = list.querySelector<HTMLInputElement>('input.plugin-toggle-input')
    assert.ok(toggle)
    toggle.checked = false
    toggle.dispatchEvent(new Event('change'))
    // The change handler awaits the IPC — let microtasks drain.
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(spy.lastSetEnabled, { id: 'copse.demo', enabled: false })
  })

  it('toggling emits settings_changed so plugin-gated chrome can wake live', async () => {
    const store = createStore()
    let settingsChanged = 0
    store.on('settings_changed', () => {
      settingsChanged += 1
    })
    const list = await openPlugins({ plugins: [demoPlugin] }, spy, store)
    const toggle = list.querySelector<HTMLInputElement>('input.plugin-toggle-input')
    assert.ok(toggle)
    toggle.checked = false
    toggle.dispatchEvent(new Event('change'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(settingsChanged, 1)
    assert.deepEqual(spy.lastSetEnabled, { id: 'copse.demo', enabled: false })
  })

  it('editing a setting field calls plugins:setSetting with the coerced value', async () => {
    const list = await openPlugins({ plugins: [demoPlugin] }, spy)
    const numberInput = list.querySelector<HTMLInputElement>('.plugin-setting-number')
    assert.ok(numberInput)
    numberInput.value = '11'
    numberInput.dispatchEvent(new Event('change'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(spy.lastSetSetting, { id: 'copse.demo', key: 'budget', value: 11 })

    const stringInput = list.querySelector<HTMLInputElement>('.plugin-setting-string')
    assert.ok(stringInput)
    stringInput.value = 'new-label'
    stringInput.dispatchEvent(new Event('change'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(spy.lastSetSetting, {
      id: 'copse.demo',
      key: 'label',
      value: 'new-label',
    })
  })
})
