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
} from './settings-dialog.ts'

// Recursive stub: api.<anything>.<nested>() returns a never-settling promise, so
// the dialog can mount without a hand-written ApiClient. Mounting fires off some
// background loads (e.g. LM Studio detection); leaving them pending — rather than
// resolving to a shape they'd then read into — keeps the test to the synchronous
// open/close contract without post-test unhandled rejections.
function stubApi(): ApiClient {
  const proxy: unknown = new Proxy(() => new Promise(() => {}), {
    get: () => proxy,
    apply: () => new Promise(() => {}),
  })
  return proxy as ApiClient
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
    dialog = document.getElementById('settings-dialog') as HTMLDialogElement
    spy = shimModal(dialog)
    // openSettingsDialog dispatches 'settings-open' to kick off an async data
    // load we don't exercise here (and can't satisfy without a full API).
    // Neutralise it so the test stays focused on the open/close contract.
    dialog.dispatchEvent = (): boolean => true
  })

  it('mounts as a native dialog element, initially closed', () => {
    assert.equal(dialog.tagName, 'DIALOG')
    assert.equal(isSettingsDialogOpen(), false)
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

describe('settings search (cross-section block filter)', () => {
  let content: HTMLElement
  let searchInput: HTMLInputElement

  function fieldsetByLegend(text: string): HTMLElement {
    const match = Array.from(
      document.querySelectorAll<HTMLElement>('.settings-content fieldset'),
    ).find((fs) => fs.querySelector('legend')?.textContent.trim() === text)
    if (!match) throw new Error(`no fieldset with legend ${JSON.stringify(text)}`)
    return match
  }

  function sectionEl(section: string): HTMLElement {
    const el = document.querySelector<HTMLElement>(`.settings-section[data-section="${section}"]`)
    if (!el) throw new Error(`no section ${section}`)
    return el
  }

  function search(value: string): void {
    searchInput.value = value
    searchInput.dispatchEvent(new Event('input'))
  }

  beforeEach(() => {
    document.body.innerHTML = ''
    mountSettingsDialog(createStore(), stubApi())
    content = document.querySelector('.settings-content') as HTMLElement
    searchInput = document.getElementById('settings-search-input') as HTMLInputElement
  })

  it('reveals a matching block from another section and hides the rest', () => {
    // "Interface tint" is an Appearance block; General is the initially-active
    // section, so a hit here proves the search crosses sections.
    search('interface tint')
    assert.ok(content.classList.contains('settings-searching'))
    assert.ok(sectionEl('appearance').classList.contains('settings-search-match'))
    assert.ok(!sectionEl('general').classList.contains('settings-search-match'))
    // The matched block is shown; a sibling block in the same section is hidden.
    assert.ok(!fieldsetByLegend('Interface tint').classList.contains('settings-search-hidden'))
    assert.ok(fieldsetByLegend('Display').classList.contains('settings-search-hidden'))
  })

  it('matches text anywhere in a block, not just its legend', () => {
    // "DevTools" appears in the checkbox label / hint of the Experimental block.
    search('devtools')
    assert.ok(sectionEl('experimental').classList.contains('settings-search-match'))
    assert.ok(!fieldsetByLegend('DevTools shortcut').classList.contains('settings-search-hidden'))
  })

  it('shows an empty-state message and no matches for an unknown term', () => {
    search('zzznotasetting')
    const empty = document.getElementById('settings-search-empty') as HTMLElement
    assert.equal(empty.hidden, false)
    assert.match(empty.textContent, /zzznotasetting/)
    const anyMatch = Array.from(document.querySelectorAll('.settings-section')).some((s) =>
      s.classList.contains('settings-search-match'),
    )
    assert.equal(anyMatch, false)
  })

  it('clearing the query restores the single-section view', () => {
    search('interface tint')
    assert.ok(content.classList.contains('settings-searching'))
    search('')
    assert.ok(!content.classList.contains('settings-searching'))
    assert.equal((document.getElementById('settings-search-empty') as HTMLElement).hidden, true)
    // Back to exactly one active section (General, the default).
    const active = document.querySelectorAll('.settings-section.active')
    assert.equal(active.length, 1)
    assert.equal((active[0] as HTMLElement).dataset['section'], 'general')
  })
})
