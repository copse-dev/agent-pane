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

describe('settings search (cross-section filter)', () => {
  let content: HTMLElement
  let searchInput: HTMLInputElement

  function matchedSections(): string[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>('.settings-section.settings-search-match'),
    )
      .map((s) => s.dataset['section'])
      .filter((s): s is string => typeof s === 'string')
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

  it('reveals the whole matching section from another nav entry', () => {
    // "Interface tint" text lives only in Appearance; General is the initially
    // active section, so a hit here proves the search crosses sections.
    search('interface tint')
    assert.ok(content.classList.contains('settings-searching'))
    assert.deepEqual(matchedSections(), ['appearance'])
    // The whole section is kept for context, not just the matched block, so a
    // sibling block in the same section stays visible (no per-block hiding).
    assert.equal(document.querySelectorAll('fieldset.settings-search-hidden').length, 0)
  })

  it('matches text in a label or hint, not just headings', () => {
    // "DevTools" appears in a checkbox label / hint inside Experimental.
    search('devtools')
    assert.deepEqual(matchedSections(), ['experimental'])
  })

  it('shows every section that contains the term at once', () => {
    // "agent" appears in General ("Remote agents") and Experimental (ACP agents).
    search('agent')
    const matched = matchedSections()
    assert.ok(matched.includes('general'))
    assert.ok(matched.includes('experimental'))
  })

  it('reveals the full ACP section when searching "acp" (no block stripping)', () => {
    // Regression: the earlier per-block filter cropped the ACP agents block out
    // of its section. A section-level match keeps Experimental whole. (ACP is
    // also referenced under Local models, so that section matches too.)
    search('acp')
    assert.ok(matchedSections().includes('experimental'))
    assert.equal(document.querySelectorAll('fieldset.settings-search-hidden').length, 0)
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
