// Verifies ordinary approvals stay *behind* the settings dialog (issue #501),
// while the provider-host approval caused by a Settings save is the deliberate
// exception: it stacks above Settings without pulling unrelated queued requests
// into the same prompt.
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
import { mountSettingsDialog, openSettingsDialog, closeSettingsDialog } from './settings-dialog.ts'
import { mountApprovalDialog } from './approval-dialog.ts'
import { resetAttention } from '../controller/attention.ts'
import { qsRequired } from '../dom/helpers.ts'
import { createPendingApi } from '../fake-api.test-support.ts'

type ApprovalHandler = (req: {
  id: string
  threadId?: string | undefined
  title: string
  body: string
  type: string
  allowRemember?: boolean
  rememberLabel?: string
  showWhileSettingsOpen?: boolean
}) => void

// Recursive never-settling stub for the settings dialog's background loads, with
// the two approval surfaces the approval dialog actually touches captured.
function makeApi(): {
  api: ApiClient
  emit: (req: { id: string; threadId?: string; showWhileSettingsOpen?: boolean }) => void
} {
  let handler: ApprovalHandler = () => {}
  const overrides = {
    'agent.onApprovalRequest': (h: ApprovalHandler): (() => void) => {
      handler = h
      return () => {}
    },
    'approval.respond': (): Promise<void> => Promise.resolve(),
  }
  const api = createPendingApi(overrides)
  return {
    api,
    emit: (req): void => {
      handler({
        id: req.id,
        threadId: req.threadId,
        title: req.showWhileSettingsOpen ? 'Provider host' : 'Shell command',
        body: req.showWhileSettingsOpen ? 'provider.example' : 'echo hello',
        type: req.showWhileSettingsOpen ? 'web' : 'shell',
        ...(req.showWhileSettingsOpen ? { showWhileSettingsOpen: true } : {}),
      })
    },
  }
}

// happy-dom doesn't implement modal dialogs; track open state and fire the native
// `close` event the real element emits from close().
function shimDialog(dialog: HTMLDialogElement): { showCalls: number; showModalCalls: number } {
  const spy = { showCalls: 0, showModalCalls: 0 }
  let open = false
  Object.defineProperties(dialog, {
    show: {
      configurable: true,
      value: () => {
        open = true
        spy.showCalls += 1
      },
    },
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
  let approvalSpy: { showCalls: number; showModalCalls: number }
  let emit: (req: { id: string; showWhileSettingsOpen?: boolean }) => void

  beforeEach(() => {
    document.body.innerHTML = ''
    const chatPane = document.createElement('section')
    chatPane.id = 'pane-chat'
    document.body.append(chatPane)
    resetAttention()
    const made = makeApi()
    emit = made.emit
    const store = createStore()
    // Settings must mount first: the approval dialog subscribes to its close event.
    mountSettingsDialog(store, made.api)
    const settings = qsRequired<HTMLDialogElement>(document, '#settings-dialog')
    shimDialog(settings)
    // openSettingsDialog also dispatches `settings-open`, kicking off async loads
    // against the never-settling stub api: those awaits never resolve, so nothing
    // rejects after the test. We leave dispatchEvent intact because the close-event
    // path is exactly what the queue flush under test relies on.

    // Fire the coalesce/settle timers inline so opening the dialog is synchronous
    // here; the timing-based batching is exercised in approval-dialog-batch.test.ts.
    mountApprovalDialog(made.api, store, {
      setTimer: (fn): (() => void) => {
        fn()
        return () => {}
      },
    })
    approvalDialog = qsRequired<HTMLDialogElement>(document, '#approval-dialog')
    approvalSpy = shimDialog(approvalDialog)
  })

  it('shows an approval prompt immediately when settings is closed', () => {
    emit({ id: 'a' })
    assert.equal(approvalSpy.showCalls, 1)
    assert.equal(approvalSpy.showModalCalls, 0)
    assert.equal(approvalDialog.open, true)
    assert.equal(approvalDialog.parentElement?.id, 'pane-chat')
    assert.equal(qsRequired(document, '.approval-chat-scrim').hidden, false)
  })

  it('defers an approval prompt while settings is open, flushing on close', () => {
    openSettingsDialog()
    emit({ id: 'a' })
    // Held back behind settings — not stacked on top of it.
    assert.equal(approvalSpy.showCalls, 0)
    assert.equal(approvalDialog.open, false)

    closeSettingsDialog()
    assert.equal(approvalSpy.showCalls, 1)
    assert.equal(approvalDialog.open, true)
  })

  it('shows a provider-host approval above settings without surfacing unrelated requests', () => {
    openSettingsDialog()
    emit({ id: 'shell' })
    emit({ id: 'provider', showWhileSettingsOpen: true })

    assert.equal(approvalSpy.showModalCalls, 1)
    assert.equal(approvalSpy.showCalls, 0)
    assert.equal(approvalDialog.open, true)
    assert.equal(qsRequired(approvalDialog, '.approval-heading').textContent, 'Provider host')
    assert.equal(qsRequired(approvalDialog, '.approval-body').textContent, 'provider.example')

    qsRequired<HTMLButtonElement>(approvalDialog, '.approval-reject').click()
    assert.equal(approvalDialog.open, false)
    assert.equal(qsRequired(document, '.approval-chat-scrim').hidden, true)

    closeSettingsDialog()
    assert.equal(approvalSpy.showModalCalls, 1)
    assert.equal(approvalSpy.showCalls, 1)
    assert.equal(qsRequired(approvalDialog, '.approval-heading').textContent, 'Shell command')
  })

  it('temporarily replaces an inline prompt when Settings needs a provider approval', () => {
    emit({ id: 'shell' })
    assert.equal(approvalSpy.showCalls, 1)

    openSettingsDialog()
    emit({ id: 'provider', showWhileSettingsOpen: true })

    assert.equal(approvalSpy.showModalCalls, 1)
    assert.equal(qsRequired(approvalDialog, '.approval-heading').textContent, 'Provider host')

    qsRequired<HTMLButtonElement>(approvalDialog, '.approval-reject').click()
    assert.equal(approvalDialog.open, false)

    closeSettingsDialog()
    assert.equal(approvalSpy.showCalls, 2)
    assert.equal(qsRequired(approvalDialog, '.approval-heading').textContent, 'Shell command')
  })
})
