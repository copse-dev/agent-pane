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

describe('approval dialog coalescing', () => {
  let dialog: HTMLDialogElement
  let spy: { showModalCalls: number }
  let emit: (req: EmitReq) => void
  let responses: Responded[]
  // Captured coalesce callback; call fireWindow() to close the opening window.
  let pending: (() => void)[]
  const fireWindow = (): void => {
    const fns = pending
    pending = []
    for (const fn of fns) fn()
  }

  beforeEach(() => {
    document.body.innerHTML = ''
    resetAttention()
    pending = []
    const made = makeApi()
    emit = made.emit
    responses = made.responses
    const store = createStore({ activeThreadId: 'focused' })
    mountSettingsDialog(store, made.api)
    mountApprovalDialog(made.api, store, (fn) => {
      pending.push(fn)
    })
    dialog = document.getElementById('approval-dialog') as HTMLDialogElement
    spy = shimModal(dialog)
  })

  const titles = (): (string | null)[] =>
    [...dialog.querySelectorAll('.approval-title')].map((n) => n.textContent)

  it('waits for the window before opening, then pops once', () => {
    emit({ id: 'a' })
    // Still gathering the burst — nothing on screen yet.
    assert.equal(spy.showModalCalls, 0)
    emit({ id: 'b' })
    fireWindow()
    // One prompt listing both requests.
    assert.equal(spy.showModalCalls, 1)
    assert.deepEqual(titles(), ['title-a', 'title-b'])
    assert.equal(dialog.querySelector('.approval-approve')?.textContent, 'Approve all (2)')
  })

  it('answers every coalesced request with one click', () => {
    emit({ id: 'a' })
    emit({ id: 'b' })
    emit({ id: 'c' })
    fireWindow()
    dialog.querySelector<HTMLButtonElement>('.approval-approve')?.click()
    assert.deepEqual(responses.map((r) => r.id).sort(), ['a', 'b', 'c'])
    assert.ok(responses.every((r) => r.approved))
    assert.equal(dialog.open, false)
  })

  it('appends a request that arrives while the dialog is already open', () => {
    emit({ id: 'a' })
    fireWindow()
    assert.equal(spy.showModalCalls, 1)
    assert.deepEqual(titles(), ['title-a'])
    // A sibling lands after the prompt is up — it joins the open list, no new modal.
    emit({ id: 'b' })
    assert.equal(spy.showModalCalls, 1)
    assert.deepEqual(titles(), ['title-a', 'title-b'])
    dialog.querySelector<HTMLButtonElement>('.approval-reject')?.click()
    assert.deepEqual(
      responses.map((r) => ({ id: r.id, approved: r.approved })),
      [
        { id: 'a', approved: false },
        { id: 'b', approved: false },
      ],
    )
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
    assert.equal(pending.length, 1)
  })
})
