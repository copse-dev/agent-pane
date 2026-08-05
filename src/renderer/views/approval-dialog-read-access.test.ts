// The read-access prompt asks a scope question ("may the agent read outside the
// project?") rather than a per-command one, so it leads with the decision and
// keeps the command behind a "Show details" disclosure. Expanding it also
// reveals the narrower answer — "Approve this command" — which is the button
// that must NOT grant the thread anything.
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { mountApprovalDialog } from './approval-dialog.ts'
import { mountSettingsDialog } from './settings-dialog.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { resetAttention } from '../controller/attention.ts'
import { qsRequired } from '../dom/helpers.ts'
import { createPendingApi } from '../fake-api.test-support.ts'

interface EmitReq {
  id: string
  title?: string
  body?: string
  bodyAdvice?: string
  collapseDetails?: boolean
  approveOnceLabel?: string
  allowRemember?: boolean
  rememberLabel?: string
}
interface Responded {
  id: string
  approved: boolean
  remember: boolean
}

const COALESCE_MS = 120
const SETTLE_MS = 500

const READ_ACCESS: EmitReq = {
  id: 'read',
  title: 'Allow read access outside of the project?',
  body: 'ls -la ~/.copse',
  bodyAdvice: 'The agent wants to read outside the project: ~/.copse',
  collapseDetails: true,
  approveOnceLabel: 'Approve this command',
}

function makeApi(): {
  api: ApiClient
  emit: (req: EmitReq) => void
  responses: Responded[]
} {
  let handler: (req: Record<string, unknown>) => void = () => {}
  const responses: Responded[] = []
  const overrides = {
    'agent.onApprovalRequest': (h: (req: Record<string, unknown>) => void): (() => void) => {
      handler = h
      return () => {}
    },
    'approval.respond': (id: string, approved: boolean, remember: boolean): Promise<void> => {
      responses.push({ id, approved, remember })
      return Promise.resolve()
    },
  }
  return {
    api: createPendingApi(overrides),
    emit: (req): void => {
      handler({
        id: req.id,
        title: req.title ?? `title-${req.id}`,
        body: req.body ?? `body-${req.id}`,
        bodyAdvice: req.bodyAdvice,
        type: 'shell',
        collapseDetails: req.collapseDetails,
        approveOnceLabel: req.approveOnceLabel,
        allowRemember: req.allowRemember,
        rememberLabel: req.rememberLabel,
      })
    },
    responses,
  }
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

describe('approval dialog — read-access prompt', () => {
  let dialog: HTMLDialogElement
  let emit: (req: EmitReq) => void
  let responses: Responded[]
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
    const made = makeApi()
    emit = made.emit
    responses = made.responses
    const store = createStore({ activeThreadId: 'focused' })
    mountSettingsDialog(store, made.api)
    mountApprovalDialog(made.api, store, {
      coalesceMs: COALESCE_MS,
      settleMs: SETTLE_MS,
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

  const button = (selector: string): HTMLButtonElement =>
    qsRequired<HTMLButtonElement>(dialog, selector)
  const approve = (): HTMLButtonElement => button('.approval-approve')
  const approveOnce = (): HTMLButtonElement => button('.approval-approve-once')
  const toggle = (): HTMLButtonElement => button('.approval-details-toggle')
  const body = (): HTMLElement => qsRequired(dialog, '.approval-body')

  it('leads with the question and hides the command until details are shown', () => {
    emit(READ_ACCESS)
    fireWindow()

    assert.equal(
      dialog.querySelector('.approval-heading')?.textContent,
      'Allow read access outside of the project?',
    )
    assert.match(dialog.querySelector('.approval-advice')?.textContent ?? '', /~\/\.copse/)
    // The command is present for assistive tech and instant reveal, but hidden.
    assert.equal(body().textContent, 'ls -la ~/.copse')
    assert.equal(body().hidden, true)
    assert.equal(toggle().textContent, 'Show details')
    assert.equal(toggle().getAttribute('aria-expanded'), 'false')
    // The per-command answer waits for the command it refers to.
    assert.equal(approveOnce().hidden, true)
  })

  it('reveals the command and the third button on expand, and collapses again', () => {
    emit(READ_ACCESS)
    fireWindow()
    toggle().click()

    assert.equal(body().hidden, false)
    assert.equal(toggle().textContent, 'Hide details')
    assert.equal(toggle().getAttribute('aria-expanded'), 'true')
    assert.equal(approveOnce().hidden, false)
    assert.equal(approveOnce().textContent, 'Approve this command')

    toggle().click()
    assert.equal(body().hidden, true)
    assert.equal(approveOnce().hidden, true)
  })

  it('sends the grant from Approve and no grant from Approve this command', () => {
    emit(READ_ACCESS)
    fireWindow()
    approve().click()
    assert.deepEqual(responses, [{ id: 'read', approved: true, remember: true }])
  })

  it('sends a one-off approval from the secondary button', () => {
    emit(READ_ACCESS)
    fireWindow()
    toggle().click()
    approveOnce().click()
    assert.deepEqual(responses, [{ id: 'read', approved: true, remember: false }])
  })

  it('rejects without granting anything', () => {
    emit(READ_ACCESS)
    fireWindow()
    button('.approval-reject').click()
    assert.deepEqual(responses, [{ id: 'read', approved: false, remember: false }])
  })

  it('drops both features when another request joins the prompt', () => {
    emit(READ_ACCESS)
    emit({ id: 'other', title: 'Run shell command?', body: 'npm test' })
    fireWindow()

    // A mixed batch shows every body and offers no grant-carrying primary click,
    // so an unrelated command can never be swept into the read-access grant.
    assert.deepEqual(
      [...dialog.querySelectorAll<HTMLElement>('.approval-body')].map((n) => n.hidden),
      [false, false],
    )
    assert.equal(dialog.querySelector('.approval-details-toggle'), null)
    assert.equal(approveOnce().hidden, true)

    approve().click()
    assert.deepEqual(responses, [
      { id: 'read', approved: true, remember: false },
      { id: 'other', approved: true, remember: false },
    ])
  })

  it('starts the next prompt collapsed again', () => {
    emit(READ_ACCESS)
    fireWindow()
    toggle().click()
    approve().click()

    emit({ ...READ_ACCESS, id: 'read-2', body: 'cat ~/.gitconfig' })
    fireWindow()
    assert.equal(body().hidden, true)
    assert.equal(approveOnce().hidden, true)
  })
})
