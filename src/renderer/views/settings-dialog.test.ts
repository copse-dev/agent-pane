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
    dialog.dispatchEvent = () => true
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
