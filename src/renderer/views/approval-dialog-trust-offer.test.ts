// A shell prompt that only exists because the project is untrusted says so, and
// lets the user trust the project from the prompt. Trusting goes through its own
// confirmation and never answers the prompt itself.
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { mountApprovalDialog } from './approval-dialog.ts'
import { mountSettingsDialog } from './settings-dialog.ts'
import {
  clickActiveConfirmDialogCancel,
  clickActiveConfirmDialogConfirm,
  mountConfirmDialog,
} from './confirm-dialog.ts'
import { resetAttention } from '../controller/attention.ts'
import { qsRequired } from '../dom/helpers.ts'
import { createPendingApi } from '../fake-api.test-support.ts'

const COALESCE_MS = 120

interface EmitReq {
  id: string
  workspaceTrustOffer?: { root: string }
}

function shimDialog(dialog: HTMLDialogElement): void {
  let open = false
  Object.defineProperties(dialog, {
    show: { configurable: true, value: () => (open = true) },
    showModal: { configurable: true, value: () => (open = true) },
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
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 6; tick++) await new Promise((done) => setTimeout(done, 0))
}

describe('approval dialog — workspace trust offer', () => {
  let dialog: HTMLDialogElement
  let emit: (req: EmitReq) => void
  let trusted: string[]
  let responses: string[]
  let timers: { fn: () => void; ms: number }[]
  const fireWindow = (): void => {
    const due = timers.filter((t) => t.ms === COALESCE_MS)
    timers = timers.filter((t) => t.ms !== COALESCE_MS)
    for (const t of due) t.fn()
  }

  beforeEach(() => {
    document.body.innerHTML = ''
    resetAttention()
    timers = []
    trusted = []
    responses = []
    let handler: (req: Record<string, unknown>) => void = () => {}
    const api = createPendingApi({
      'agent.onApprovalRequest': (h: (req: Record<string, unknown>) => void): (() => void) => {
        handler = h
        return () => {}
      },
      'approval.respond': (id: string): Promise<void> => {
        responses.push(id)
        return Promise.resolve()
      },
      'workspace.unsandboxedProjectHooks': () => Promise.resolve([]),
      'workspace.trustFromApproval': (id: string): Promise<true> => {
        trusted.push(id)
        return Promise.resolve(true)
      },
    })
    emit = (req): void => {
      handler({
        title: 'Run shell command?',
        body: `cmd-${req.id}`,
        type: 'shell',
        ...req,
      })
    }
    const store = createStore({ activeThreadId: 'focused' })
    mountSettingsDialog(store, api)
    mountConfirmDialog()
    mountApprovalDialog(api, store, {
      coalesceMs: COALESCE_MS,
      setTimer: (fn, ms): (() => void) => {
        const entry = { fn, ms }
        timers.push(entry)
        return () => {
          timers = timers.filter((t) => t !== entry)
        }
      },
    })
    dialog = qsRequired<HTMLDialogElement>(document, '#approval-dialog')
    shimDialog(dialog)
  })

  const offer = (): HTMLElement => qsRequired(dialog, '.approval-trust-offer')
  const offerButton = (): HTMLButtonElement =>
    qsRequired<HTMLButtonElement>(dialog, '.approval-trust-offer-btn')

  it('stays hidden on a prompt that trust would not remove', () => {
    emit({ id: 'a' })
    fireWindow()
    assert.equal(offer().hidden, true)
  })

  it('says untrusted is why it asks, and trusts only after the confirmation', async () => {
    emit({ id: 'a', workspaceTrustOffer: { root: '/repo' } })
    fireWindow()
    assert.equal(offer().hidden, false)
    assert.match(offer().textContent, /isn't trusted/)

    offerButton().click()
    await settle()
    clickActiveConfirmDialogCancel()
    await settle()
    assert.deepEqual(trusted, [])

    offerButton().click()
    await settle()
    clickActiveConfirmDialogConfirm()
    await settle()
    assert.deepEqual(trusted, ['a'])
    assert.match(offer().textContent, /Project trusted/)
    assert.equal(offerButton().hidden, true)
    // Trusting is not an answer: the command still waits for Approve or Reject.
    assert.deepEqual(responses, [])
    assert.equal(dialog.open, true)
  })

  it('hides the offer when the batch mixes prompts it would not fix', () => {
    emit({ id: 'a', workspaceTrustOffer: { root: '/repo' } })
    emit({ id: 'b' })
    fireWindow()
    assert.equal(offer().hidden, true)
  })
})
