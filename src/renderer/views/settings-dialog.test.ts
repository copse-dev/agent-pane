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
import type { ApiClient } from '../../preload/api.d.ts'
import {
  mountSettingsDialog,
  openSettingsDialog,
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

  beforeEach(() => {
    document.body.innerHTML = ''
    mountSettingsDialog(createStore(), stubApi())
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
    const settingWrites: [string, unknown][] = []
    let securityWrites = 0
    let iconApplies = 0
    const api: ApiClient = {
      ...base,
      settings: {
        ...base.settings,
        set: async (name, value) => {
          settingWrites.push([name, value])
        },
        setSecurity: async () => {
          securityWrites += 1
        },
      },
      appIcon: {
        apply: async () => {
          iconApplies += 1
        },
      },
    }
    mountSettingsDialog(createStore(), api)
    const form = qsRequired<HTMLFormElement>(document, '.settings-content')
    const theme = qsRequired<HTMLSelectElement>(form, 'select[name="theme"]')
    theme.value = 'light'
    theme.dispatchEvent(new Event('change', { bubbles: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepEqual(settingWrites, [['theme', 'light']])
    assert.equal(securityWrites, 0)
    assert.equal(iconApplies, 0)
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
    // "verdicts" appears only in the Model comparison hint, not in any legend, so
    // a hit proves the search reaches label/hint body copy — not just headings.
    search('verdicts')
    assert.deepEqual(resultLegends(), ['Model comparison'])
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
