// A burst of concurrent `session/request_permission` calls (an agent running
// several tool calls at once) should coalesce into ONE prompt: the first request
// waits a short window, then the dialog pops listing every request gathered so
// far, and any that land while it is open are appended live. One click answers
// them all.
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
  threadId?: string
  title?: string
  body?: string
  allowRemember?: boolean
  rememberLabel?: string
  allowTurnTreeLease?: boolean
  turnTreeLeaseLabel?: string
  turnTreeLeaseSubject?: string
}
interface Responded {
  id: string
  approved: boolean
  remember: boolean
  grantScope?: 'turn-tree'
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
    'approval.respond': (
      id: string,
      approved: boolean,
      remember: boolean,
      _comparisonModels: unknown,
      grantScope?: 'once' | 'turn-tree',
    ): Promise<void> => {
      responses.push({
        id,
        approved,
        remember,
        ...(grantScope === 'turn-tree' ? { grantScope } : {}),
      })
      return Promise.resolve()
    },
  }
  return {
    api: createPendingApi(overrides),
    emit: (req): void => {
      handler({
        id: req.id,
        threadId: req.threadId,
        title: req.title ?? `title-${req.id}`,
        body: req.body ?? `body-${req.id}`,
        type: 'shell',
        allowRemember: req.allowRemember,
        rememberLabel: req.rememberLabel,
        allowTurnTreeLease: req.allowTurnTreeLease,
        turnTreeLeaseLabel:
          req.turnTreeLeaseLabel ??
          (req.allowTurnTreeLease ? 'Allow exact retries for this task' : undefined),
        // The real label is one shared constant, so the subject is what tells two
        // batched offers apart. Default it to a single command unless a test
        // deliberately varies it.
        turnTreeLeaseSubject:
          req.turnTreeLeaseSubject ?? (req.allowTurnTreeLease ? 'npm test' : undefined),
      })
    },
    responses,
  }
}

function shimDialog(dialog: HTMLDialogElement): { showCalls: number } {
  const spy = { showCalls: 0 }
  let open = false
  Object.defineProperties(dialog, {
    show: {
      configurable: true,
      value: () => {
        open = true
        spy.showCalls += 1
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

const COALESCE_MS = 120
const SETTLE_MS = 500

describe('approval dialog coalescing', () => {
  let dialog: HTMLDialogElement
  let spy: { showCalls: number }
  let emit: (req: EmitReq) => void
  let responses: Responded[]
  // Scheduled timers, tagged by their delay so a test can fire the coalesce
  // (opening) window and the settle (Approve re-enable) window independently.
  let timers: { fn: () => void; ms: number }[]
  const fireTimers = (ms: number): void => {
    const due = timers.filter((t) => t.ms === ms)
    timers = timers.filter((t) => t.ms !== ms)
    for (const t of due) t.fn()
  }
  const fireWindow = (): void => {
    fireTimers(COALESCE_MS)
  }
  const fireSettle = (): void => {
    fireTimers(SETTLE_MS)
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
    spy = shimDialog(dialog)
  })

  const approve = (): HTMLButtonElement => {
    const button = dialog.querySelector<HTMLButtonElement>('.approval-approve')
    if (!button) throw new Error('approve button missing')
    return button
  }
  const heading = (): string | null =>
    dialog.querySelector('.approval-heading')?.textContent ?? null
  // Each request always renders its body, so the body set is the stable way to
  // read which requests are on screen regardless of single/collapsed/mixed layout.
  const bodies = (): (string | null)[] =>
    [...dialog.querySelectorAll('.approval-body')].map((n) => n.textContent)
  const rowTitles = (): (string | null)[] =>
    [...dialog.querySelectorAll('.approval-item-title')].map((n) => n.textContent)

  it('waits for the window before opening, then pops once', () => {
    emit({ id: 'a' })
    // Still gathering the burst — nothing on screen yet.
    assert.equal(spy.showCalls, 0)
    emit({ id: 'b' })
    fireWindow()
    // One prompt listing both requests.
    assert.equal(spy.showCalls, 1)
    assert.deepEqual(bodies(), ['body-a', 'body-b'])
    assert.equal(approve().textContent, 'Approve all (2)')
  })

  it('collapses a repeated header into a single heading', () => {
    // Both requests ask the same question (parallel fetches) — the header should
    // appear once, with no noisy per-row title repetition, just the two bodies.
    emit({ id: 'a', title: 'Fetch from the web? — Claude', body: 'fetch one' })
    emit({ id: 'b', title: 'Fetch from the web? — Claude', body: 'fetch two' })
    fireWindow()
    assert.equal(heading(), 'Fetch from the web? — Claude')
    assert.deepEqual(rowTitles(), [])
    assert.deepEqual(bodies(), ['fetch one', 'fetch two'])
  })

  it('keeps per-row labels and a count heading for a mixed batch', () => {
    emit({ id: 'a', title: 'Run shell command? — Claude' })
    emit({ id: 'b', title: 'Fetch from the web? — Claude' })
    fireWindow()
    assert.equal(heading(), '2 requests')
    assert.deepEqual(rowTitles(), ['Run shell command? — Claude', 'Fetch from the web? — Claude'])
  })

  it('answers every coalesced request with one click', () => {
    emit({ id: 'a' })
    emit({ id: 'b' })
    emit({ id: 'c' })
    fireWindow()
    approve().click()
    assert.deepEqual(responses.map((r) => r.id).sort(), ['a', 'b', 'c'])
    assert.ok(responses.every((r) => r.approved))
    assert.equal(dialog.open, false)
  })

  it('appends a request that arrives while the dialog is already open', () => {
    emit({ id: 'a' })
    fireWindow()
    assert.equal(spy.showCalls, 1)
    assert.deepEqual(bodies(), ['body-a'])
    // A sibling lands after the prompt is up — it joins the open list, no new modal.
    emit({ id: 'b' })
    assert.equal(spy.showCalls, 1)
    assert.deepEqual(bodies(), ['body-a', 'body-b'])
    dialog.querySelector<HTMLButtonElement>('.approval-reject')?.click()
    assert.deepEqual(
      responses.map((r) => ({ id: r.id, approved: r.approved })),
      [
        { id: 'a', approved: false },
        { id: 'b', approved: false },
      ],
    )
  })

  it('pauses Approve when a request is appended, until the batch settles', () => {
    emit({ id: 'a' })
    fireWindow()
    // Fresh prompt: Approve is live immediately (no appended change yet).
    assert.equal(approve().disabled, false)

    // A command lands under the open prompt — Approve is paused so it can't be
    // clicked through the unread change (clickjack guard).
    emit({ id: 'b' })
    assert.equal(approve().disabled, true)
    approve().click()
    assert.equal(responses.length, 0)

    // Once the list has held still for the settle window, Approve returns.
    fireSettle()
    assert.equal(approve().disabled, false)
    approve().click()
    assert.deepEqual(responses.map((r) => r.id).sort(), ['a', 'b'])
    assert.ok(responses.every((r) => r.approved))
  })

  it('keeps Reject live while Approve is paused, so a mis-click can only deny', () => {
    emit({ id: 'a' })
    fireWindow()
    emit({ id: 'b' })
    assert.equal(approve().disabled, true)
    dialog.querySelector<HTMLButtonElement>('.approval-reject')?.click()
    assert.deepEqual(responses.map((r) => r.id).sort(), ['a', 'b'])
    assert.ok(responses.every((r) => !r.approved))
  })

  it('re-arms the settle window on each successive append', () => {
    emit({ id: 'a' })
    fireWindow()
    emit({ id: 'b' })
    // A second append restarts the window: firing the first append's timer must
    // not re-enable Approve while a newer change is still settling.
    emit({ id: 'c' })
    assert.equal(approve().disabled, true)
    fireSettle()
    assert.equal(approve().disabled, false)
  })

  it('shows the remember checkbox only when the batch shares one grant', () => {
    const remember = qsRequired(dialog, '.approval-remember')
    // Same agent+kind grant across the batch → checkbox offered, applied to all.
    emit({ id: 'a', allowRemember: true, rememberLabel: 'Always allow Codex terminal commands' })
    emit({ id: 'b', allowRemember: true, rememberLabel: 'Always allow Codex terminal commands' })
    fireWindow()
    assert.equal(remember.hidden, false)
    const input = dialog.querySelector<HTMLInputElement>('.approval-remember-input')
    assert.ok(input)
    input.checked = true
    dialog.querySelector<HTMLButtonElement>('.approval-approve')?.click()
    assert.ok(responses.every((r) => r.remember))
  })

  it('hides the remember checkbox for a mixed-grant batch', () => {
    const remember = qsRequired(dialog, '.approval-remember')
    emit({ id: 'a', allowRemember: true, rememberLabel: 'Always allow Codex terminal commands' })
    emit({ id: 'b', allowRemember: true, rememberLabel: 'Always allow Codex web fetches' })
    fireWindow()
    assert.equal(remember.hidden, true)
  })

  it('never pre-ticks bounded retries, and leases only when the user ticks', () => {
    const lease = qsRequired(dialog, '.approval-turn-tree')
    emit({ id: 'a', allowTurnTreeLease: true })
    emit({ id: 'b', allowTurnTreeLease: true })
    fireWindow()
    assert.equal(lease.hidden, false)
    const input = qsRequired<HTMLInputElement>(lease, '.approval-turn-tree-input')
    // A lease is a standing grant to re-run without asking again, so approving
    // without touching the box must stay a one-shot.
    assert.equal(input.checked, false)
    input.checked = true
    approve().click()
    assert.ok(responses.every((response) => response.grantScope === 'turn-tree'))
  })

  it('hides task retries when batched offers cover different commands', () => {
    const lease = qsRequired(dialog, '.approval-turn-tree')
    // Same label — it is one shared constant in the gate — but different
    // commands. One tick box issues one lease PER request, so offering it here
    // would grant retries for a command the tick never named.
    emit({ id: 'a', allowTurnTreeLease: true, turnTreeLeaseSubject: 'npm test' })
    emit({ id: 'b', allowTurnTreeLease: true, turnTreeLeaseSubject: 'npm run build' })
    fireWindow()
    assert.equal(lease.hidden, true)
    approve().click()
    assert.ok(responses.every((response) => response.grantScope === undefined))
  })

  it('defaults outside-sandbox retries to one-shot approval', () => {
    const lease = qsRequired(dialog, '.approval-turn-tree')
    emit({ id: 'a', allowTurnTreeLease: true })
    fireWindow()
    const input = qsRequired<HTMLInputElement>(lease, '.approval-turn-tree-input')
    assert.equal(input.checked, false)
    approve().click()
    assert.ok(responses.every((response) => response.grantScope === undefined))
  })

  it('hides task retries for mixed eligibility and defaults to one-shot approval', () => {
    const lease = qsRequired(dialog, '.approval-turn-tree')
    emit({ id: 'a', allowTurnTreeLease: true })
    emit({ id: 'b' })
    fireWindow()
    assert.equal(lease.hidden, true)
    approve().click()
    assert.ok(responses.every((response) => response.grantScope === undefined))
  })

  it('coalesces the opening burst under a single scheduled window', () => {
    emit({ id: 'a' })
    emit({ id: 'b' })
    // The delay counts from the first request, so the burst shares one timer.
    assert.equal(timers.length, 1)
  })
})
