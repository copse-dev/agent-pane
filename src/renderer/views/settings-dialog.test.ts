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
    content = document.querySelector('.settings-content') as HTMLElement
    searchInput = document.getElementById('settings-search-input') as HTMLInputElement
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
    // "Interface tint" lives only in Appearance; General is the initially active
    // section, so a hit here proves the search crosses sections.
    search('interface tint')
    assert.ok(content.classList.contains('settings-searching'))
    assert.deepEqual(resultLegends(), ['Interface tint'])
  })

  it('matches text in a label or hint, not just the heading', () => {
    // "DevTools" appears in a checkbox label / hint inside the Experimental block.
    search('devtools')
    assert.deepEqual(resultLegends(), ['DevTools shortcut'])
  })

  it('ranks a heading (legend) match above a body-only match', () => {
    // "ACP agents" names the block via its legend; other blocks (e.g. Local
    // models routing) only mention ACP in body copy, so they sort after it.
    search('acp')
    const legends = resultLegends()
    assert.ok(legends.length >= 2, `expected multiple ACP matches, got ${JSON.stringify(legends)}`)
    assert.equal(legends[0], 'ACP agents')
  })

  it('shows an empty-state message and no results for an unknown term', () => {
    search('zzznotasetting')
    const empty = document.getElementById('settings-search-empty') as HTMLElement
    assert.equal(empty.hidden, false)
    assert.match(empty.textContent, /zzznotasetting/)
    assert.equal(resultLegends().length, 0)
  })

  it('clearing the query restores blocks to their sections', () => {
    search('interface tint')
    assert.ok(content.classList.contains('settings-searching'))
    assert.deepEqual(resultLegends(), ['Interface tint'])
    search('')
    assert.ok(!content.classList.contains('settings-searching'))
    assert.equal(document.querySelectorAll('#settings-search-results > *').length, 0)
    assert.equal((document.getElementById('settings-search-empty') as HTMLElement).hidden, true)
    // The Interface tint block is back inside the Appearance section.
    const appearance = document.querySelector('.settings-section[data-section="appearance"]')
    const legends = Array.from(appearance?.querySelectorAll('legend') ?? []).map((l) =>
      l.textContent.trim(),
    )
    assert.ok(legends.includes('Interface tint'))
    // Back to exactly one active section (General, the default).
    const active = document.querySelectorAll('.settings-section.active')
    assert.equal(active.length, 1)
    assert.equal((active[0] as HTMLElement).dataset['section'], 'general')
  })
})
