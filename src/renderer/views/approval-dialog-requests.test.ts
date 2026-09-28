// The approval dialog's queue, as the Activity panel sees it: every pending
// request is listed, and answering one from outside the dialog goes through the
// dialog's own queue to the same `approval.respond` — once, and never for a
// request that is no longer pending.
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { AppStore } from '@shared/store/store.ts'
import { mountApprovalDialog, type ApprovalRequests } from './approval-dialog.ts'
import { mountSettingsDialog } from './settings-dialog.ts'
import { isThreadAwaitingAttention, resetAttention } from '../controller/attention.ts'
import { qsRequired } from '../dom/helpers.ts'
import { createPendingApi } from '../fake-api.test-support.ts'

interface Emitted {
  id: string
  threadId?: string | undefined
  title: string
  body: string
  type: string
}

interface Responded {
  id: string
  approved: boolean
  remember: boolean | undefined
  grantScope: string | undefined
}

/** happy-dom has no <dialog> modality; `open` tracking is all this suite needs. */
function patchDialogs(): void {
  Object.defineProperties(window.HTMLDialogElement.prototype, {
    show: {
      configurable: true,
      value(this: HTMLDialogElement): void {
        this.open = true
      },
    },
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement): void {
        this.open = true
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement): void {
        this.open = false
        this.dispatchEvent(new window.Event('close'))
      },
    },
  })
}

describe('approval requests handle', () => {
  let store: AppStore
  let requests: ApprovalRequests
  let emit: (req: Emitted) => void
  let cancel: (id: string) => void
  let responses: Responded[]
  let dialog: HTMLDialogElement

  beforeEach(() => {
    document.body.innerHTML = ''
    patchDialogs()
    resetAttention()
    let onRequest: (req: Emitted) => void = () => {}
    let onCancelled: (payload: { id: string }) => void = () => {}
    responses = []
    const api = createPendingApi({
      'agent.onApprovalRequest': (handler: (req: Emitted) => void): (() => void) => {
        onRequest = handler
        return () => {}
      },
      'agent.onApprovalCancelled': (handler: (p: { id: string }) => void): (() => void) => {
        onCancelled = handler
        return () => {}
      },
      'approval.respond': (
        id: string,
        approved: boolean,
        remember?: boolean,
        grantScope?: string,
      ): Promise<void> => {
        responses.push({ id, approved, remember, grantScope })
        return Promise.resolve()
      },
    })
    emit = (req): void => {
      onRequest(req)
    }
    cancel = (id): void => {
      onCancelled({ id })
    }
    store = createStore({ activeThreadId: 'focused' })
    mountSettingsDialog(store, api)
    requests = mountApprovalDialog(api, store, {
      setTimer: (fn): (() => void) => {
        fn()
        return () => {}
      },
    })
    dialog = qsRequired<HTMLDialogElement>(document, '#approval-dialog')
  })

  const shell = (id: string, threadId?: string): Emitted => ({
    id,
    threadId,
    title: 'Run shell command?',
    body: `echo ${id}`,
    type: 'shell',
  })

  it('lists queued and on-screen requests, oldest first', () => {
    emit(shell('background', 'other'))
    emit(shell('foreground', 'focused'))
    assert.equal(dialog.open, true)
    assert.deepEqual(
      requests.pending().map((req) => [req.id, req.threadId, req.body]),
      [
        ['background', 'other', 'echo background'],
        ['foreground', 'focused', 'echo foreground'],
      ],
    )
  })

  it('answers a background request once, without a grant, and clears its bell', () => {
    let changes = 0
    requests.onChange(() => {
      changes++
    })
    emit(shell('background', 'other'))
    assert.equal(isThreadAwaitingAttention('other'), true)
    const before = changes

    assert.equal(requests.answerOnce('background', true), true)
    assert.deepEqual(responses, [
      { id: 'background', approved: true, remember: false, grantScope: 'once' },
    ])
    assert.deepEqual(requests.pending(), [])
    assert.equal(isThreadAwaitingAttention('other'), false)
    assert.ok(changes > before, 'the panel hears that the pending set changed')
  })

  it('takes an answered request off the open prompt and keeps its siblings', () => {
    emit(shell('a', 'focused'))
    emit(shell('b', 'focused'))
    assert.equal(qsRequired(dialog, '.approval-heading').textContent, 'Run shell command?')
    assert.equal(dialog.querySelectorAll('.approval-body').length, 2)

    assert.equal(requests.answerOnce('a', false), true)
    assert.deepEqual(responses, [{ id: 'a', approved: false, remember: false, grantScope: 'once' }])
    assert.equal(dialog.open, true)
    assert.deepEqual(
      [...dialog.querySelectorAll('.approval-body')].map((body) => body.textContent),
      ['echo b'],
    )

    assert.equal(requests.answerOnce('b', true), true)
    assert.equal(dialog.open, false)
  })

  it('is idempotent: a request already answered or cancelled sends nothing', () => {
    emit(shell('twice', 'other'))
    assert.equal(requests.answerOnce('twice', true), true)
    assert.equal(requests.answerOnce('twice', true), false)

    emit(shell('cancelled', 'other'))
    cancel('cancelled')
    assert.equal(requests.answerOnce('cancelled', true), false)

    // Answered on the prompt first, then clicked in the panel's stale row.
    emit(shell('prompted', 'focused'))
    qsRequired<HTMLButtonElement>(dialog, '.approval-reject').click()
    assert.equal(requests.answerOnce('prompted', true), false)

    assert.equal(requests.answerOnce('never-existed', false), false)
    assert.deepEqual(
      responses.map((r) => [r.id, r.approved]),
      [
        ['twice', true],
        ['prompted', false],
      ],
    )
  })
})
