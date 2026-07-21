// Settings → Packs list rendering (P3 of docs/plans/hooks-and-feature-packs.md).
//
// The pack list is the "about:addons" of Copse: one row per registered pack
// with an enable/disable toggle that flips the shared PackRegistry atomically
// (P1 contract), an enumeration of what the pack contributes, and a generic
// settings block rendered from the manifest schema. This spec exercises the
// component in a happy-dom shim so the assertions can inspect the DOM the same
// way the WDIO e2e will (with real Chromium doing full layout).
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore, type AppStore } from '@shared/store/store.ts'
import type { PackSummary, PacksListResult } from '@shared/types/packs.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountSettingsDialog } from './settings-dialog.ts'

/** Records the last mutation the stub received so click-through assertions can inspect it. */
interface StubApiSpy {
  lastSetEnabled: { id: string; enabled: boolean } | null
  lastSetSetting: { id: string; key: string; value: unknown } | null
}

function stubApi(initial: PacksListResult, spy: StubApiSpy): ApiClient {
  let current = initial
  const fallback: unknown = new Proxy(() => new Promise(() => {}), {
    get: () => fallback,
    apply: () => new Promise(() => {}),
  })
  const overrides: Record<string, unknown> = {
    instructions: { list: () => Promise.resolve([]) },
    cursorRules: { list: () => Promise.resolve([]) },
    skills: { list: () => Promise.resolve([]) },
    plugins: { list: () => Promise.resolve([]) },
    hooks: { list: () => Promise.resolve({ hooks: [], warnings: [] }) },
    packs: {
      list: () => Promise.resolve(current),
      setEnabled: (id: string, enabled: boolean) => {
        spy.lastSetEnabled = { id, enabled }
        current = {
          packs: current.packs.map((p) => (p.id === id ? { ...p, enabled } : p)),
        }
        return Promise.resolve(current)
      },
      setSetting: (id: string, key: string, value: unknown) => {
        spy.lastSetSetting = { id, key, value }
        current = {
          packs: current.packs.map((p) => {
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
    },
  }
  const proxy: unknown = new Proxy(
    {},
    {
      get: (_target, prop) =>
        typeof prop === 'string' && prop in overrides ? overrides[prop] : fallback,
    },
  )
  return proxy as ApiClient
}

const demoPack: PackSummary = {
  id: 'copse.demo',
  trust: 'first-party',
  name: 'copse.demo',
  version: '1.2.3',
  description: 'A demonstration pack.',
  enabled: true,
  contributions: {
    toolNames: ['demo_tool'],
    blockingHooks: [{ id: 'demo-hook', event: 'turnStart' }],
    asyncHooks: [],
    commandHooks: [],
    promptBlocks: [{ id: 'demo-steer', trust: 'trusted' }],
    ui: [{ id: 'demo-panel', level: 2, slot: 'sidebar', title: 'Demo panel', panelKind: 'list' }],
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

const disabledUserPack: PackSummary = {
  id: 'sample.user',
  trust: 'user',
  name: 'sample.user',
  enabled: false,
  contributions: {
    toolNames: [],
    blockingHooks: [],
    asyncHooks: [],
    commandHooks: [{ event: 'toolGate', command: './guard.sh' }],
    promptBlocks: [],
    ui: [],
  },
  settings: [],
}

async function openPacks(
  initial: PacksListResult,
  spy: StubApiSpy,
  store: AppStore = createStore(),
): Promise<HTMLElement> {
  document.body.innerHTML = ''
  mountSettingsDialog(store, stubApi(initial, spy))
  const btn = document.querySelector<HTMLButtonElement>('.settings-nav-btn[data-section="packs"]')
  assert.ok(btn)
  btn.click()
  // refreshPacks() awaits api.packs.list — let the microtask queue drain.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const list = document.getElementById('packs-list')
  assert.ok(list)
  return list
}

describe('settings → packs list', () => {
  let spy: StubApiSpy

  beforeEach(() => {
    document.body.innerHTML = ''
    spy = { lastSetEnabled: null, lastSetSetting: null }
  })

  it('renders a nav button and empty state', async () => {
    const list = await openPacks({ packs: [] }, spy)
    const btn = document.querySelector('.settings-nav-btn[data-section="packs"]')
    assert.ok(btn)
    assert.match(btn.textContent, /Packs/)
    assert.match(list.textContent, /No packs registered\./)
  })

  it('describes packs without internal design-doc leaks, linking the manifest docs', async () => {
    await openPacks({ packs: [] }, spy)
    const section = document.querySelector('.settings-section[data-section="packs"]')
    assert.ok(section)
    const desc = section.querySelector('.settings-section-desc')
    assert.ok(desc)
    assert.doesNotMatch(desc.textContent, /decision\s*17/i)
    assert.doesNotMatch(desc.innerHTML, /<code>\s*docs\/packs\.md\s*<\/code>/i)
    const docsLink = desc.querySelector<HTMLAnchorElement>(
      'a[href="https://github.com/copse-dev/agent-pane/blob/main/docs/packs.md"]',
    )
    assert.ok(docsLink)
    assert.equal(docsLink.target, '_blank')
    assert.match(docsLink.rel, /noopener/)
    assert.match(docsLink.textContent, /pack manifest docs/i)
  })

  it('renders one row per pack with a toggle, name, version, and trust badge', async () => {
    const list = await openPacks({ packs: [demoPack, disabledUserPack] }, spy)
    const rows = list.querySelectorAll('.pack-row')
    assert.equal(rows.length, 2)

    const first = rows[0]
    assert.ok(first)
    assert.equal(first.getAttribute('data-pack-id'), 'copse.demo')
    assert.equal(first.getAttribute('data-enabled'), 'true')
    assert.equal(first.querySelector('.pack-name')?.textContent, 'copse.demo')
    assert.equal(first.querySelector('.pack-version')?.textContent, '1.2.3')
    assert.equal(first.querySelector('.pack-badge-first-party')?.textContent, 'first-party')
    const toggle = first.querySelector<HTMLInputElement>('input.pack-toggle-input')
    assert.ok(toggle)
    assert.equal(toggle.type, 'checkbox')
    assert.equal(toggle.checked, true)

    const second = rows[1]
    assert.ok(second)
    assert.equal(second.getAttribute('data-enabled'), 'false')
    assert.ok(second.classList.contains('pack-row-disabled'))
    assert.equal(second.querySelector('.pack-badge-user')?.textContent, 'user')
    assert.equal(second.querySelector<HTMLInputElement>('input.pack-toggle-input')?.checked, false)
  })

  it('enumerates tools / hooks / prompt / UI as chips with counts', async () => {
    const list = await openPacks({ packs: [demoPack] }, spy)
    const chips = list.querySelectorAll('.pack-chip')
    const chipTexts = Array.from(chips).map((el) => el.textContent)
    assert.deepEqual(chipTexts, ['Tools × 1', 'Hooks × 1', 'Prompt blocks × 1', 'UI × 1'])
  })

  it('shows a "contributes nothing" note for skeleton packs', async () => {
    const skeleton: PackSummary = {
      ...demoPack,
      id: 'copse.skeleton',
      contributions: {
        toolNames: [],
        blockingHooks: [],
        asyncHooks: [],
        commandHooks: [],
        promptBlocks: [],
        ui: [],
      },
      settings: [],
    }
    const list = await openPacks({ packs: [skeleton] }, spy)
    assert.match(list.textContent, /Contributes nothing yet/)
  })

  it('renders manifest settings fields with current values', async () => {
    const list = await openPacks({ packs: [demoPack] }, spy)
    const fields = list.querySelectorAll('.pack-setting-field')
    assert.equal(fields.length, 2)
    const numberInput = list.querySelector<HTMLInputElement>('.pack-setting-number')
    assert.ok(numberInput)
    assert.equal(numberInput.value, '3')
    const stringInput = list.querySelector<HTMLInputElement>('.pack-setting-string')
    assert.ok(stringInput)
    assert.equal(stringInput.value, 'hi')
  })

  it('toggling calls packs:setEnabled with the flipped state', async () => {
    const list = await openPacks({ packs: [demoPack] }, spy)
    const toggle = list.querySelector<HTMLInputElement>('input.pack-toggle-input')
    assert.ok(toggle)
    toggle.checked = false
    toggle.dispatchEvent(new Event('change'))
    // The change handler awaits the IPC — let microtasks drain.
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(spy.lastSetEnabled, { id: 'copse.demo', enabled: false })
  })

  it('toggling emits settings_changed so pack-gated chrome can wake live', async () => {
    const store = createStore()
    let settingsChanged = 0
    store.on('settings_changed', () => {
      settingsChanged += 1
    })
    const list = await openPacks({ packs: [demoPack] }, spy, store)
    const toggle = list.querySelector<HTMLInputElement>('input.pack-toggle-input')
    assert.ok(toggle)
    toggle.checked = false
    toggle.dispatchEvent(new Event('change'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(settingsChanged, 1)
    assert.deepEqual(spy.lastSetEnabled, { id: 'copse.demo', enabled: false })
  })

  it('editing a setting field calls packs:setSetting with the coerced value', async () => {
    const list = await openPacks({ packs: [demoPack] }, spy)
    const numberInput = list.querySelector<HTMLInputElement>('.pack-setting-number')
    assert.ok(numberInput)
    numberInput.value = '11'
    numberInput.dispatchEvent(new Event('change'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(spy.lastSetSetting, { id: 'copse.demo', key: 'budget', value: 11 })

    const stringInput = list.querySelector<HTMLInputElement>('.pack-setting-string')
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
