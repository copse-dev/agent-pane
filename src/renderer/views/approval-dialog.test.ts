// Verifies the approval dialog stays *behind* the settings dialog (issue #501):
// while Settings is open, an approval request arriving from a background chat is
// queued rather than stacked on top of the settings modal, and is surfaced once
// the user leaves Settings.
//
// happy-dom has no modal-dialog implementation, so we shim showModal/close/open
// on both dialogs. The shim's close() dispatches the native `close` event the
// real <dialog> fires — that event is exactly what onSettingsDialogClose() (and
// thus the queue flush) depends on.
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  mountSettingsDialog,
  openSettingsDialog,
  closeSettingsDialog,
} from './settings-dialog.ts'
import { mountApprovalDialog } from './approval-dialog.ts'

type ApprovalHandler = (req: {
  id: string
  title: string
  body: string
  type: string
  allowRemember?: boolean
  rememberLabel?: string
}) => void

// Recursive never-settling stub for the settings dialog's background loads, with
// the two approval surfaces the approval dialog actually touches captured.
function makeApi(): { api: ApiClient; emit: (req: { id: string }) => void } {
  let handler: ApprovalHandler = () => {}
  const overrides: Record<string, unknown> = {
    'agent.onApprovalRequest': (h: ApprovalHandler) => {
      handler = h
      return () => {}
    },
    'approval.respond': () => Promise.resolve(),
  }
  const make = (path: string): unknown =>
    new Proxy(() => new Promise(() => {}), {
      get: (_t, prop) => make(path ? `${path}.${String(prop)}` : String(prop)),
      apply: (_t, _this, args) => {
        const override = overrides[path]
        if (typeof override === 'function') return (override as (...a: unknown[]) => unknown)(...args)
        return new Promise(() => {})
      },
    })
  const api = make('') as ApiClient
  return {
    api,
    emit: (req) =>
      handler({ id: req.id, title: 't', body: 'b', type: 'shell' }),
  }
}

// happy-dom doesn't implement modal dialogs; track open state and fire the native
// `close` event the real element emits from close().
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
        if (!open) return
        open = false
        dialog.dispatchEvent(new Event('close'))
      },
    },
    open: { configurable: true, get: () => open },
  })
  return spy
}

describe('approval dialog vs settings (issue #501)', () => {
  let approvalDialog: HTMLDialogElement
  let approvalSpy: { showModalCalls: number }
  let emit: (req: { id: string }) => void

  beforeEach(() => {
    document.body.innerHTML = ''
    const made = makeApi()
    emit = made.emit
    // Settings must mount first: the approval dialog subscribes to its close event.
    mountSettingsDialog(createStore(), made.api)
    const settings = document.getElementById('settings-dialog') as HTMLDialogElement
    shimModal(settings)
    // openSettingsDialog also dispatches `settings-open`, kicking off async loads
    // against the never-settling stub api: those awaits never resolve, so nothing
    // rejects after the test. We leave dispatchEvent intact because the close-event
    // path is exactly what the queue flush under test relies on.

    mountApprovalDialog(made.api)
    approvalDialog = document.getElementById('approval-dialog') as HTMLDialogElement
    approvalSpy = shimModal(approvalDialog)
  })

  it('shows an approval prompt immediately when settings is closed', () => {
    emit({ id: 'a' })
    assert.equal(approvalSpy.showModalCalls, 1)
    assert.equal(approvalDialog.open, true)
  })

  it('defers an approval prompt while settings is open, flushing on close', () => {
    openSettingsDialog()
    emit({ id: 'a' })
    // Held back behind settings — not stacked on top of it.
    assert.equal(approvalSpy.showModalCalls, 0)
    assert.equal(approvalDialog.open, false)

    closeSettingsDialog()
    assert.equal(approvalSpy.showModalCalls, 1)
    assert.equal(approvalDialog.open, true)
  })
})
