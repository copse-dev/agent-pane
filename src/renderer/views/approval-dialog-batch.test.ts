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

interface EmitReq {
  id: string
  threadId?: string
  title?: string
  body?: string
  allowRemember?: boolean
  rememberLabel?: string
}
interface Responded {
  id: string
  approved: boolean
  remember: boolean
}

function makeApi(): {
  api: ApiClient
  emit: (req: EmitReq) => void
  responses: Responded[]
} {
  let handler: (req: Record<string, unknown>) => void = () => {}
  const responses: Responded[] = []
  const overrides: Record<string, unknown> = {
    'agent.onApprovalRequest': (h: (req: Record<string, unknown>) => void) => {
      handler = h
      return () => {}
    },
    'approval.respond': (id: string, approved: boolean, remember: boolean) => {
      responses.push({ id, approved, remember })
      return Promise.resolve()
    },
  }
  const make = (path: string): unknown =>
    new Proxy(() => new Promise(() => {}), {
      get: (_t, prop) => make(path ? `${path}.${String(prop)}` : String(prop)),
      apply: (_t, _this, args): unknown => {
        const override = overrides[path]
        if (typeof override === 'function')
          return (override as (...a: unknown[]) => unknown)(...(args as unknown[]))
        return new Promise(() => {})
      },
    })
  return {
    api: make('') as ApiClient,
    emit: (req): void => {
      handler({
        id: req.id,
        threadId: req.threadId,
        title: req.title ?? `title-${req.id}`,
        body: req.body ?? `body-${req.id}`,
        type: 'shell',
        allowRemember: req.allowRemember,
        rememberLabel: req.rememberLabel,
      })
    },
    responses,
  }
}

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

const COALESCE_MS = 120
const SETTLE_MS = 500

describe('approval dialog coalescing', () => {
  let dialog: HTMLDialogElement
  let spy: { showModalCalls: number }
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
    dialog = document.getElementById('approval-dialog') as HTMLDialogElement
    spy = shimModal(dialog)
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
    assert.equal(spy.showModalCalls, 0)
    emit({ id: 'b' })
    fireWindow()
    // One prompt listing both requests.
    assert.equal(spy.showModalCalls, 1)
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
    assert.equal(spy.showModalCalls, 1)
    assert.deepEqual(bodies(), ['body-a'])
    // A sibling lands after the prompt is up — it joins the open list, no new modal.
    emit({ id: 'b' })
    assert.equal(spy.showModalCalls, 1)
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
    const remember = dialog.querySelector('.approval-remember') as HTMLElement
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
    const remember = dialog.querySelector('.approval-remember') as HTMLElement
    emit({ id: 'a', allowRemember: true, rememberLabel: 'Always allow Codex terminal commands' })
    emit({ id: 'b', allowRemember: true, rememberLabel: 'Always allow Codex web fetches' })
    fireWindow()
    assert.equal(remember.hidden, true)
  })

  it('coalesces the opening burst under a single scheduled window', () => {
    emit({ id: 'a' })
    emit({ id: 'b' })
    // The delay counts from the first request, so the burst shares one timer.
    assert.equal(timers.length, 1)
  })
})
