import { deferred } from '../../../tests/deferred.ts'
// Verifies the settings dialog is a native <dialog> driven by showModal()/close()
// — the migration away from a hand-rolled div + `hidden` toggle.
//
// happy-dom has no modal-dialog implementation (no showModal/close/open), so we
// shim those to track open state — exactly the surface the migration depends on.
// The real top-layer behaviour (focus trap, Esc-to-close, inert background) is
// covered by the Chromium e2e settings specs.
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { SettingsUpdate } from '@shared/settings-contract.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { CursorRuleSummary } from '@shared/types/cursor-rules.ts'
import {
  mountSettingsDialog,
  openSettingsDialog,
  openModelSettings,
  closeSettingsDialog,
  isSettingsDialogOpen,
  applyUiAccent,
  applyUiTint,
  DEFAULT_ACCENT_COLOR,
  DEFAULT_TINT_COLOR,
  DEFAULT_TINT_STRENGTH,
} from './settings-dialog.ts'
import { qsRequired } from '../dom/helpers.ts'
import { createFakeApi, createPendingApi } from '../fake-api.test-support.ts'

// Recursive stub: api.<anything>.<nested>() returns a never-settling promise, so
// the dialog can mount without a hand-written ApiClient. Mounting fires off some
// background loads (e.g. LM Studio detection); leaving them pending — rather than
// resolving to a shape they'd then read into — keeps the test to the synchronous
// open/close contract without post-test unhandled rejections.
function stubApi(): ApiClient {
  return createPendingApi()
}

// happy-dom doesn't implement modal dialogs; track open state through the methods
// the dialog code actually calls.
function shimModal(dialog: HTMLDialogElement): { showModalCalls: number } {
  const spy = { showModalCalls: 0 }
  let open = false
  Object.defineProperties(dialog, {
    showModal: {
      configurable: true,
      value: () => {
        open = true
        spy.showModalCalls += 1
      },
    },
    close: {
      configurable: true,
      value: () => {
        open = false
      },
    },
    open: { configurable: true, get: () => open },
  })
  return spy
}

describe('settings dialog (native <dialog>)', () => {
  let dialog: HTMLDialogElement
  let spy: { showModalCalls: number }
  let mobileManageCalls: number

  beforeEach(() => {
    document.body.innerHTML = ''
    mobileManageCalls = 0
    mountSettingsDialog(
      createStore(),
      createPendingApi({
        'mobile.manage': async () => {
          mobileManageCalls += 1
        },
      }),
    )
    dialog = qsRequired<HTMLDialogElement>(document, '#settings-dialog')
    spy = shimModal(dialog)
    // openSettingsDialog dispatches 'settings-open' to kick off an async data
    // load we don't exercise here (and can't satisfy without a full API).
    // Neutralise it so the test stays focused on the open/close contract.
    dialog.dispatchEvent = (): boolean => true
  })

  it('mounts as a native dialog element, initially closed', () => {
    assert.equal(dialog.tagName, 'DIALOG')
    assert.equal(isSettingsDialogOpen(), false)
    assert.ok(dialog.querySelector('#settings-close svg[data-icon="close"]'))
    assert.equal(dialog.querySelector('#settings-close')?.textContent, '')
  })

  it('opens via showModal() and closes via close()', () => {
    openSettingsDialog()
    assert.equal(spy.showModalCalls, 1)
    assert.equal(isSettingsDialogOpen(), true)

    closeSettingsDialog()
    assert.equal(isSettingsDialogOpen(), false)
  })

  it('open is idempotent while already open', () => {
    openSettingsDialog()
    openSettingsDialog()
    assert.equal(spy.showModalCalls, 1)
    assert.equal(isSettingsDialogOpen(), true)
  })

  function prepareRecoveryDialog(): void {
    document.body.innerHTML = ''
    mountSettingsDialog(createStore(), createFakeApi())
    dialog = qsRequired<HTMLDialogElement>(document, '#settings-dialog')
    spy = shimModal(dialog)
  }
  async function settleRecovery(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }

  it('reveals and focuses model recovery when Settings is already open on another section', async () => {
    prepareRecoveryDialog()
    openSettingsDialog()
    await settleRecovery()
    qsRequired(dialog, '.settings-nav-btn[data-section="appearance"]').click()
    const models = qsRequired(dialog, '[data-model-setting-target="model"]')
    let scrolled = false
    Object.defineProperty(models, 'scrollIntoView', {
      value: (): void => {
        scrolled = true
      },
    })
    openModelSettings()
    await settleRecovery()
    assert.equal(spy.showModalCalls, 1)
    assert.ok(dialog.querySelector('.settings-section.active[data-section="general"]'))
    assert.equal(document.activeElement === models, true)
    assert.ok(scrolled)
  })

  it('clears search before revealing a model recovery target', async () => {
    prepareRecoveryDialog()
    openSettingsDialog()
    await settleRecovery()
    const search = qsRequired<HTMLInputElement>(dialog, '#settings-search-input')
    search.value = 'nothing-matches-this-setting'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    assert.ok(qsRequired(dialog, '.settings-content').classList.contains('settings-searching'))
    openModelSettings('model')
    await settleRecovery()
    assert.equal(search.value, '')
    assert.equal(
      qsRequired(dialog, '.settings-content').classList.contains('settings-searching'),
      false,
    )
    assert.equal(document.activeElement?.getAttribute('data-model-setting-target'), 'model')
  })

  it('opens folded exact role/security fields instead of only the Models heading', async () => {
    prepareRecoveryDialog()
    openSettingsDialog()
    await settleRecovery()
    openModelSettings('safetyModel')
    await settleRecovery()
    assert.equal(document.activeElement?.getAttribute('data-model-setting-target'), 'safetyModel')
    assert.equal(dialog.querySelector<HTMLDetailsElement>('.routing-advanced')?.open, true)
    openModelSettings('role:docs')
    await settleRecovery()
    assert.equal(document.activeElement.getAttribute('data-model-setting-target'), 'role:docs')
    assert.equal(dialog.querySelector<HTMLDetailsElement>('.routing-additional-roles')?.open, true)
    openModelSettings('orchestrationWorkerModel')
    await settleRecovery()
    assert.ok(dialog.querySelector('.settings-section.active[data-section="experimental"]'))
    assert.equal(
      document.activeElement.getAttribute('data-model-setting-target'),
      'orchestrationWorkerModel',
    )
  })

  it('moves Mobile Companion management into Experimental settings', async () => {
    openSettingsDialog('experimental')
    const button = qsRequired<HTMLButtonElement>(dialog, '#mobile-companion-manage')
    assert.match(button.textContent, /Set up or manage/)
    button.click()
    await Promise.resolve()
    assert.equal(mobileManageCalls, 1)
    assert.equal(isSettingsDialogOpen(), false)
  })

  it('tells the user auto-approval only applies while the project sandbox is running', () => {
    const hint = qsRequired(dialog, 'select[name="shellAutoApprovalLevel"] ~ .field-hint')
    const text = hint.textContent.replace(/\s+/g, ' ')
    assert.match(text, /only while the project sandbox is running/i)
    assert.match(text, /Without a sandbox/i)
    assert.doesNotMatch(text, /write shapes still ask/)
  })
})

describe('accent colour', () => {
  it('applies the hue and chooses readable text for light and dark accents', () => {
    applyUiAccent('#2A9D8F')
    assert.equal(document.documentElement.style.getPropertyValue('--accent-color'), '#2A9D8F')
    assert.equal(document.documentElement.style.getPropertyValue('--text-on-accent'), '#444444')

    applyUiAccent('#312E81')
    assert.equal(document.documentElement.style.getPropertyValue('--accent-color'), '#312E81')
    assert.equal(document.documentElement.style.getPropertyValue('--text-on-accent'), '#ffffff')
  })
})

describe('interface tint', () => {
  it('uses the requested first-run colours and keeps the site palette opt-in', () => {
    assert.equal(DEFAULT_ACCENT_COLOR, '#FF93D0')
    assert.equal(DEFAULT_TINT_COLOR, '#244C25')
    assert.equal(DEFAULT_TINT_STRENGTH, 'subtle')

    applyUiTint(DEFAULT_TINT_COLOR, DEFAULT_TINT_STRENGTH)
    assert.equal(document.documentElement.style.getPropertyValue('--tint-hue'), '#244C25')
    assert.equal(document.documentElement.style.getPropertyValue('--tint-amount'), '4%')
    assert.equal(document.documentElement.dataset['tintPalette'], 'custom')
    assert.equal(document.documentElement.dataset['tintStrength'], 'subtle')

    applyUiTint('#002E2B', 'strong')
    assert.equal(document.documentElement.dataset['tintPalette'], 'copse')
    assert.equal(document.documentElement.dataset['tintStrength'], 'strong')
  })
})

describe('appearance live preview', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    document.documentElement.removeAttribute('style')
    delete document.documentElement.dataset['theme']
    delete document.documentElement.dataset['tintPalette']
    delete document.documentElement.dataset['tintStrength']
  })

  it('applies theme, accent, tint, and strength as their controls change', () => {
    const store = createStore()
    applyUiAccent(DEFAULT_ACCENT_COLOR)
    applyUiTint(DEFAULT_TINT_COLOR, DEFAULT_TINT_STRENGTH)
    mountSettingsDialog(store, stubApi())
    const form = qsRequired<HTMLFormElement>(document, '.settings-content')
    const theme = qsRequired<HTMLSelectElement>(form, 'select[name="theme"]')
    const accent = qsRequired<HTMLInputElement>(form, 'input[name="uiAccentColor"]')
    const tint = qsRequired<HTMLInputElement>(form, 'input[name="uiTintColor"]')
    const strength = qsRequired<HTMLInputElement>(form, 'input[name="uiTintStrength"]')

    theme.value = 'light'
    accent.value = '#345678'
    tint.value = '#123456'
    strength.value = '2'
    tint.dispatchEvent(new Event('change', { bubbles: true }))

    assert.equal(store.getState().theme, 'light')
    assert.equal(document.documentElement.dataset['theme'], 'light')
    assert.equal(document.documentElement.style.getPropertyValue('--accent-color'), '#345678')
    assert.equal(document.documentElement.style.getPropertyValue('--tint-hue'), '#123456')
    assert.equal(document.documentElement.style.getPropertyValue('--tint-amount'), '8%')
  })

  it('restores the opening appearance when Cancel closes a live preview', () => {
    const store = createStore()
    applyUiAccent(DEFAULT_ACCENT_COLOR)
    applyUiTint(DEFAULT_TINT_COLOR, DEFAULT_TINT_STRENGTH)
    mountSettingsDialog(store, stubApi())
    const dialog = qsRequired<HTMLDialogElement>(document, '#settings-dialog')
    shimModal(dialog)
    openSettingsDialog()

    const accent = qsRequired<HTMLInputElement>(dialog, 'input[name="uiAccentColor"]')
    accent.value = '#345678'
    accent.dispatchEvent(new Event('input', { bubbles: true }))
    assert.equal(document.documentElement.style.getPropertyValue('--accent-color'), '#345678')

    closeSettingsDialog()
    dialog.dispatchEvent(new Event('close'))
    assert.equal(
      document.documentElement.style.getPropertyValue('--accent-color'),
      DEFAULT_ACCENT_COLOR,
    )
    assert.equal(document.documentElement.style.getPropertyValue('--tint-hue'), DEFAULT_TINT_COLOR)
  })

  it('persists only the changed theme and skips unrelated slow save work', async () => {
    const base = createFakeApi()
    const settingWrites: SettingsUpdate[] = []
    let securityWrites = 0
    let iconApplies = 0
    const api: ApiClient = {
      ...base,
      settings: {
        ...base.settings,
        update: async (changes) => {
          settingWrites.push(changes)
        },
        setSecurity: async () => {
          securityWrites += 1
        },
      },
      appIcon: {
        ...base.appIcon,
        apply: async () => {
          iconApplies += 1
        },
      },
    }
    mountSettingsDialog(createStore(), api)
    const dialog = qsRequired<HTMLDialogElement>(document, '#settings-dialog')
    shimModal(dialog)
    openSettingsDialog('appearance')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const form = qsRequired<HTMLFormElement>(document, '.settings-content')
    const theme = qsRequired<HTMLSelectElement>(form, 'select[name="theme"]')
    theme.value = 'light'
    theme.dispatchEvent(new Event('change', { bubbles: true }))
    assert.equal(qsRequired<HTMLButtonElement>(form, 'button[type="submit"]').disabled, false)

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepEqual(settingWrites, [{ theme: 'light' }])
    assert.equal(securityWrites, 0)
    assert.equal(iconApplies, 0)
  })
})

// A fieldset whose only content would be "there are none" is noise, and most
// projects carry no Cursor rules at all — so the block only earns its space once
// the workspace actually has rules to list.
describe('Cursor rules block visibility', () => {
  function mountWithRules(rules: CursorRuleSummary[]): HTMLElement {
    document.body.innerHTML = ''
    mountSettingsDialog(
      createStore(),
      createPendingApi({
        'settings.getSnapshot': () => Promise.resolve({}),
        'instructions.list': () => Promise.resolve([]),
        'cursorRules.list': () => Promise.resolve(rules),
        'skills.sources': () =>
          Promise.resolve({ skills: [], diagnostics: [], extraRoots: [], reload: 'manual' }),
        'agents.list': () => Promise.resolve({ agents: [], skipped: [], shadowed: [] }),
        'hooks.list': () => Promise.resolve({ hooks: [], warnings: [] }),
      }),
    )
    return qsRequired(document, '#cursor-rules-fieldset')
  }

  // refreshSources awaits an api round-trip; drain the microtask queue after it.
  async function reloadSources(): Promise<void> {
    qsRequired(document, '#sources-reload-btn').dispatchEvent(new Event('click'))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('stays hidden when the workspace has no Cursor rules', async () => {
    const fieldset = mountWithRules([])
    assert.equal(fieldset.hidden, true)
    await reloadSources()
    assert.equal(fieldset.hidden, true)
  })

  it('appears once the workspace has a rule to list', async () => {
    const fieldset = mountWithRules([
      {
        path: '/repo/.cursor/rules/style.mdc',
        name: '.cursor/rules/style.mdc',
        kind: 'always',
        bytes: 42,
      },
    ])
    await reloadSources()
    assert.equal(fieldset.hidden, false)
    assert.match(qsRequired(document, '#sources-cursor-rules-list').textContent, /style\.mdc/)
  })
})

describe('settings search (cross-section block filter)', () => {
  let content: HTMLElement
  let searchInput: HTMLInputElement

  function resultLegends(): string[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>('#settings-search-results > fieldset > legend'),
    ).map((l) => l.textContent.trim())
  }

  function search(value: string): void {
    searchInput.value = value
    searchInput.dispatchEvent(new Event('input'))
  }

  beforeEach(() => {
    document.body.innerHTML = ''
    mountSettingsDialog(createStore(), stubApi())
    content = qsRequired(document, '.settings-content')
    searchInput = qsRequired<HTMLInputElement>(document, '#settings-search-input')
  })

  it('focuses the search input when the dialog opens', () => {
    let focused = false
    searchInput.focus = (): void => {
      focused = true
    }
    document.getElementById('settings-dialog')?.dispatchEvent(new Event('settings-open'))
    assert.ok(focused)
  })

  it('lifts a matching block out of another section into the results list', () => {
    // "Interface tint" lives inside Interface colours in Appearance; General is the initially active
    // section, so a hit here proves the search crosses sections.
    search('interface tint')
    assert.ok(content.classList.contains('settings-searching'))
    assert.deepEqual(resultLegends(), ['Interface colours'])
  })

  it('matches text in a label or hint, not just the heading', () => {
    // "diagnostics menu" appears only in the Developer mode hint, not in any
    // legend, so a hit proves the search reaches label/hint body copy — not
    // just headings.
    search('diagnostics menu')
    assert.deepEqual(resultLegends(), ['Developer mode'])
  })

  it('does not render the retired standalone DevTools shortcut fieldset', () => {
    assert.equal(
      Array.from(document.querySelectorAll('legend')).some(
        (l) => l.textContent.trim() === 'DevTools shortcut',
      ),
      false,
    )
  })

  it('excludes developer-only settings from search while Developer mode is off', () => {
    search('cursor hooks')
    assert.deepEqual(resultLegends(), [])
  })

  it('ranks a heading (legend) match above a body-only match', () => {
    // "Models" names the block via its legend; other blocks (Providers, Helpers)
    // only mention models in body copy, so they sort after it.
    search('models')
    const legends = resultLegends()
    assert.ok(
      legends.length >= 2,
      `expected multiple model matches, got ${JSON.stringify(legends)}`,
    )
    assert.equal(legends[0], 'Models')
  })

  it('shows an empty-state message and no results for an unknown term', () => {
    search('zzznotasetting')
    const empty = qsRequired(document, '#settings-search-empty')
    assert.equal(empty.hidden, false)
    assert.match(empty.textContent, /zzznotasetting/)
    assert.equal(resultLegends().length, 0)
  })

  it('clearing the query restores blocks to their sections', () => {
    search('interface tint')
    assert.ok(content.classList.contains('settings-searching'))
    assert.deepEqual(resultLegends(), ['Interface colours'])
    search('')
    assert.ok(!content.classList.contains('settings-searching'))
    assert.equal(document.querySelectorAll('#settings-search-results > *').length, 0)
    assert.equal(qsRequired(document, '#settings-search-empty').hidden, true)
    // The combined Interface colours block is back inside the Appearance section.
    const appearance = document.querySelector('.settings-section[data-section="appearance"]')
    const legends = Array.from(appearance?.querySelectorAll('legend') ?? []).map((l) =>
      l.textContent.trim(),
    )
    assert.ok(legends.includes('Interface colours'))
    // Back to exactly one active section (General, the default).
    const active = document.querySelectorAll('.settings-section.active')
    assert.equal(active.length, 1)
    const activeSection = active.item(0)
    assert.ok(activeSection instanceof HTMLElement)
    assert.equal(activeSection.dataset['section'], 'general')
  })
})

describe('model-role cancellation before async Settings refresh', () => {
  it('does not persist a cancelled role draft when reopening Appearance and saving before catalogue reads settle', async () => {
    document.body.innerHTML = ''
    const updates: SettingsUpdate[] = []
    const base = createFakeApi()
    const catalogue = deferred<Awaited<ReturnType<ApiClient['lmStudio']['modelInfo']>>>()
    const api: ApiClient = {
      ...base,
      lmStudio: { ...base.lmStudio, modelInfo: async () => catalogue.promise },
      settings: {
        ...base.settings,
        getSnapshot: async () => ({}),
        update: async (changes) => {
          updates.push(changes)
        },
      },
    }
    mountSettingsDialog(createStore(), api)
    const dialog = qsRequired<HTMLDialogElement>(document, '#settings-dialog')
    shimModal(dialog)
    openSettingsDialog()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const docs = qsRequired<HTMLSelectElement>(dialog, 'select[name="role:docs"]')
    const option = document.createElement('option')
    option.value = 'missing-provider:docs'
    docs.append(option)
    docs.value = option.value
    docs.dispatchEvent(new Event('change', { bubbles: true }))
    closeSettingsDialog()
    dialog.dispatchEvent(new Event('close'))
    openSettingsDialog('appearance')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const theme = qsRequired<HTMLSelectElement>(dialog, 'select[name="theme"]')
    theme.value = 'light'
    theme.dispatchEvent(new Event('change', { bubbles: true }))
    qsRequired(dialog, 'form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(updates, [{ theme: 'light' }], 'only the fresh Appearance edit reaches Save')
    catalogue.resolve([])
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })
})

describe('Settings snapshot and submitted draft lifecycle', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })
  const tick = async (): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  function mounted(api: ApiClient): HTMLDialogElement {
    mountSettingsDialog(createStore(), api)
    const dialog = qsRequired<HTMLDialogElement>(document, '#settings-dialog')
    shimModal(dialog)
    return dialog
  }
  function change(
    input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
    value: string,
  ): void {
    input.value = value
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  function submit(dialog: HTMLDialogElement): void {
    qsRequired<HTMLFormElement>(dialog, 'form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
  }

  it('loads one snapshot and defers Sources until its section is visible', async () => {
    const base = createFakeApi()
    let snapshots = 0
    let individualReads = 0
    let sourceLoads = 0
    const dialog = mounted({
      ...base,
      settings: {
        ...base.settings,
        getSnapshot: async () => {
          snapshots += 1
          return { theme: 'dark' }
        },
        get: async (key) => {
          individualReads += 1
          return base.settings.get(key)
        },
      },
      skills: {
        ...base.skills,
        sources: async () => {
          sourceLoads += 1
          return base.skills.sources()
        },
      },
    })
    openSettingsDialog('appearance')
    await tick()
    assert.equal(snapshots, 1)
    assert.equal(individualReads, 0)
    assert.equal(sourceLoads, 0)
    qsRequired<HTMLButtonElement>(dialog, 'button[data-section="customise"]').click()
    await tick()
    assert.equal(sourceLoads, 1)
    assert.equal(snapshots, 1)
  })

  it('ignores a previous open snapshot after close and reopen', async () => {
    const base = createFakeApi()
    const first = deferred<{ theme: 'light' }>()
    let calls = 0
    const dialog = mounted({
      ...base,
      settings: {
        ...base.settings,
        getSnapshot: async () => (++calls === 1 ? first.promise : { theme: 'dark' }),
      },
    })
    openSettingsDialog('appearance')
    assert.equal(qsRequired(dialog, '[data-section="appearance"].settings-section').inert, true)
    closeSettingsDialog()
    dialog.dispatchEvent(new Event('close'))
    openSettingsDialog('appearance')
    await tick()
    first.resolve({ theme: 'light' })
    await tick()
    assert.equal(qsRequired<HTMLSelectElement>(dialog, '[name="theme"]').value, 'dark')
    assert.equal(qsRequired(dialog, '[data-section="appearance"].settings-section').inert, false)
  })

  it('keeps model drafts while retrying an aborted initial catalogue load', async () => {
    const base = createFakeApi()
    const initialCatalogue = deferred<Awaited<ReturnType<ApiClient['lmStudio']['modelInfo']>>>()
    let catalogueReads = 0
    const writes: SettingsUpdate[] = []
    const dialog = mounted({
      ...base,
      lmStudio: {
        ...base.lmStudio,
        modelInfo: async () => {
          catalogueReads += 1
          return catalogueReads === 1 ? initialCatalogue.promise : []
        },
      },
      settings: {
        ...base.settings,
        getSnapshot: async () => ({ model: 'gpt-4o', roleModels: { docs: 'gpt-4o' } }),
        update: async (values) => {
          writes.push(values)
        },
      },
    })
    openSettingsDialog('general')
    await tick()
    await tick()
    assert.ok(catalogueReads > 0)
    const role = qsRequired<HTMLSelectElement>(dialog, '[name="role:docs"]')
    assert.ok(role.querySelector('option[value="gpt-4o"]'))
    change(role, '')
    change(qsRequired<HTMLInputElement>(dialog, '[name="modelTemperature"]'), '0.8')
    qsRequired<HTMLButtonElement>(dialog, 'button[data-section="appearance"]').click()
    qsRequired<HTMLButtonElement>(dialog, 'button[data-section="general"]').click()
    await tick()
    assert.equal(qsRequired<HTMLInputElement>(dialog, '[name="modelTemperature"]').value, '0.8')
    assert.ok(catalogueReads > 1, 'returning retries the aborted catalogue probe')
    initialCatalogue.resolve([])
    await tick()
    submit(dialog)
    await tick()
    assert.equal(qsRequired(dialog, '#settings-save-status').textContent, '')
    assert.deepEqual(writes, [
      { modelParameters: { 'gpt-4o': { temperature: 0.8 } }, roleAssignments: { docs: '' } },
    ])
  })

  it('discards cancelled model parameters and roles when reopening another section', async () => {
    const base = createFakeApi()
    const writes: SettingsUpdate[] = []
    const dialog = mounted({
      ...base,
      settings: {
        ...base.settings,
        getSnapshot: async () => ({ model: 'gpt-4o', roleModels: { docs: 'gpt-4o' } }),
        update: async (values) => {
          writes.push(values)
        },
      },
    })
    openSettingsDialog('general')
    await tick()
    await tick()
    change(qsRequired<HTMLSelectElement>(dialog, '[name="role:docs"]'), '')
    change(qsRequired<HTMLInputElement>(dialog, '[name="modelTemperature"]'), '0.7')
    closeSettingsDialog()
    dialog.dispatchEvent(new Event('close'))
    openSettingsDialog('appearance')
    await tick()
    change(qsRequired<HTMLSelectElement>(dialog, '[name="theme"]'), 'light')
    submit(dialog)
    await tick()
    assert.deepEqual(writes, [{ theme: 'light' }])
  })

  it('keeps one submitted draft until ordinary and dedicated saves settle', async () => {
    const base = createFakeApi()
    const commit = deferred<undefined>()
    let securityWrites = 0
    const dialog = mounted({
      ...base,
      settings: {
        ...base.settings,
        update: async () => commit.promise,
        setSecurity: async (values) => {
          securityWrites += 1
          assert.equal(values.autoRunSandboxCommands, true)
        },
      },
    })
    openSettingsDialog('appearance')
    await tick()
    const safety = qsRequired<HTMLInputElement>(dialog, '[name="autoRunSandboxCommands"]')
    safety.checked = true
    safety.dispatchEvent(new Event('change', { bubbles: true }))
    submit(dialog)
    closeSettingsDialog()
    assert.equal(dialog.open, true)
    assert.equal(qsRequired<HTMLButtonElement>(dialog, '#settings-close').disabled, true)
    assert.equal(qsRequired(dialog, '.settings-body').inert, true)
    const escape = new Event('cancel', { cancelable: true })
    dialog.dispatchEvent(escape)
    assert.equal(escape.defaultPrevented, true)
    commit.resolve(undefined)
    await tick()
    assert.equal(securityWrites, 1)
    assert.equal(dialog.open, false)
  })

  it('cancels new appearance previews back to the saved value after a dedicated save fails', async () => {
    const base = createFakeApi()
    const dialog = mounted({
      ...base,
      settings: {
        ...base.settings,
        getSnapshot: async () => ({ theme: 'dark' }),
        update: async () => {},
        setSecurity: async () => {
          throw new Error('Security save failed')
        },
      },
    })
    openSettingsDialog('appearance')
    await tick()
    const theme = qsRequired<HTMLSelectElement>(dialog, '[name="theme"]')
    change(theme, 'light')
    const safety = qsRequired<HTMLInputElement>(dialog, '[name="autoRunSandboxCommands"]')
    safety.checked = true
    safety.dispatchEvent(new Event('change', { bubbles: true }))
    submit(dialog)
    await tick()
    assert.equal(dialog.open, true)
    assert.match(qsRequired(dialog, '#settings-save-status').textContent, /Security save failed/)
    change(theme, 'dark')
    closeSettingsDialog()
    dialog.dispatchEvent(new Event('close'))
    assert.equal(document.documentElement.dataset['theme'], 'light')
  })

  it('keeps failed ordinary saves open and never starts dedicated writes', async () => {
    const base = createFakeApi()
    let securityWrites = 0
    const dialog = mounted({
      ...base,
      settings: {
        ...base.settings,
        update: async () => {
          throw new Error('Storage is full')
        },
        setSecurity: async () => {
          securityWrites += 1
        },
      },
    })
    openSettingsDialog('appearance')
    await tick()
    const safety = qsRequired<HTMLInputElement>(dialog, '[name="autoRunSandboxCommands"]')
    safety.checked = true
    safety.dispatchEvent(new Event('change', { bubbles: true }))
    change(qsRequired<HTMLSelectElement>(dialog, '[name="theme"]'), 'light')
    submit(dialog)
    await tick()
    assert.equal(securityWrites, 0)
    assert.equal(dialog.open, true)
    assert.match(qsRequired(dialog, '#settings-save-status').textContent, /Storage is full/)
    assert.equal(qsRequired(dialog, '.settings-body').inert, false)
  })
})

describe('MCP declared-server navigation', () => {
  it('tracks asynchronous declarations and keeps search free of sidebar headings', async () => {
    document.body.innerHTML = ''
    const base = createFakeApi()
    let declared = deferred<Awaited<ReturnType<ApiClient['mcp']['listDeclared']>>>()
    mountSettingsDialog(createStore(), {
      ...base,
      mcp: { ...base.mcp, listDeclared: async () => declared.promise },
    })
    const dialog = qsRequired<HTMLDialogElement>(document, '#settings-dialog')
    shimModal(dialog)
    openSettingsDialog()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    qsRequired(dialog, '.settings-nav-btn[data-section="mcp"]').click()
    declared.resolve([
      {
        name: 'example',
        pluginId: 'example.plugin',
        pluginEnabled: false,
        transport: 'stdio',
        reason: 'Disabled',
      },
    ])
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(qsRequired(dialog, '#mcp-declared-fieldset').hidden, false)
    assert.match(
      qsRequired(dialog, '.settings-nav-subheadings').textContent,
      /Declared by plugins, not running/,
    )
    declared = deferred<Awaited<ReturnType<ApiClient['mcp']['listDeclared']>>>()
    qsRequired(dialog, '#mcp-reload-btn').click()
    declared.resolve([])
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(qsRequired(dialog, '#mcp-declared-fieldset').hidden, true)
    assert.doesNotMatch(
      qsRequired(dialog, '.settings-nav-subheadings').textContent,
      /Declared by plugins/,
    )
    declared = deferred<Awaited<ReturnType<ApiClient['mcp']['listDeclared']>>>()
    qsRequired(dialog, '#mcp-reload-btn').click()
    const search = qsRequired<HTMLInputElement>(dialog, '#settings-search-input')
    search.value = 'servers'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    declared.resolve([])
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(dialog.querySelector('.settings-nav-subheadings'), null)
    closeSettingsDialog()
  })
})
