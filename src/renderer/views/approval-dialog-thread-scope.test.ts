// A shell/MCP approval that belongs to a *background* thread must not pop a
// modal over whichever thread the user is focused on. Instead the request waits,
// its thread is flagged for attention (the sidebar bell), and the prompt only
// surfaces once the user switches to that thread.
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountApprovalDialog } from './approval-dialog.ts'
import { mountSettingsDialog } from './settings-dialog.ts'
import { isThreadAwaitingAttention, resetAttention } from '../controller/attention.ts'

type ApprovalHandler = (req: {
  id: string
  threadId?: string | undefined
  title: string
  body: string
  type: string
}) => void

interface Responded {
  id: string
  approved: boolean
}

function makeApi(): {
  api: ApiClient
  emit: (req: { id: string; threadId?: string }) => void
  responses: Responded[]
} {
  let handler: ApprovalHandler = () => {}
  const responses: Responded[] = []
  const overrides: Record<string, unknown> = {
    'agent.onApprovalRequest': (h: ApprovalHandler) => {
      handler = h
      return () => {}
    },
    'approval.respond': (id: string, approved: boolean) => {
      responses.push({ id, approved })
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
      handler({ id: req.id, threadId: req.threadId, title: 't', body: 'b', type: 'shell' })
    },
    responses,
  }
}

// jsdom reports `document.visibilityState` as 'visible' via a prototype getter;
// shadow it on the instance so we can simulate minimizing the window, then fire
// the `visibilitychange` event the renderer listens for.
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event('visibilitychange'))
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

describe('approval dialog thread scoping', () => {
  let store: AppStore
  let dialog: HTMLDialogElement
  let spy: { showModalCalls: number }
  let emit: (req: { id: string; threadId?: string }) => void
  let responses: Responded[]

  beforeEach(() => {
    document.body.innerHTML = ''
    resetAttention()
    const made = makeApi()
    emit = made.emit
    responses = made.responses
    store = createStore({ activeThreadId: 'focused' })
    // The approval dialog subscribes to the settings dialog's close event, which
    // requires settings to be mounted first. We never open it here.
    mountSettingsDialog(store, made.api)
    mountApprovalDialog(made.api, store)
    dialog = document.getElementById('approval-dialog') as HTMLDialogElement
    spy = shimModal(dialog)
  })

  it('shows a prompt immediately for the focused thread', () => {
    emit({ id: 'a', threadId: 'focused' })
    assert.equal(spy.showModalCalls, 1)
    assert.equal(dialog.open, true)
    assert.equal(isThreadAwaitingAttention('focused'), false)
  })

  it('defers a background-thread prompt and flags it for attention', () => {
    emit({ id: 'a', threadId: 'other' })
    assert.equal(spy.showModalCalls, 0)
    assert.equal(dialog.open, false)
    assert.equal(isThreadAwaitingAttention('other'), true)
  })

  it('surfaces the deferred prompt and clears the flag when its thread is focused', () => {
    emit({ id: 'a', threadId: 'other' })
    assert.equal(isThreadAwaitingAttention('other'), true)

    // User switches to the waiting thread.
    store.setState({ activeThreadId: 'other' })
    store.emit('threads_changed')

    assert.equal(spy.showModalCalls, 1)
    assert.equal(dialog.open, true)
    assert.equal(isThreadAwaitingAttention('other'), false)
  })

  it('keeps the focused prompt on screen while a background one waits', () => {
    emit({ id: 'foreground', threadId: 'focused' })
    emit({ id: 'background', threadId: 'other' })

    assert.equal(spy.showModalCalls, 1)
    assert.equal(isThreadAwaitingAttention('other'), true)

    // Answering the focused prompt does not auto-pop the background one; it
    // stays flagged until the user visits its thread.
    dialog.querySelector<HTMLButtonElement>('.approval-approve')?.click()
    assert.deepEqual(responses, [{ id: 'foreground', approved: true }])
    assert.equal(dialog.open, false)
    assert.equal(isThreadAwaitingAttention('other'), true)
  })

  it('shows a request with no threadId regardless of focus', () => {
    emit({ id: 'a' })
    assert.equal(spy.showModalCalls, 1)
    assert.equal(dialog.open, true)
  })

  describe('minimized (hidden) window', () => {
    afterEach(() => {
      // Leave the shared document visible for any later specs in this process.
      setVisibility('visible')
    })

    it('defers a focused-thread prompt and flags it for attention while hidden', () => {
      setVisibility('hidden')
      emit({ id: 'a', threadId: 'focused' })

      // No invisible modal on a minimized window; surface a bell instead so the
      // pane doesn't look frozen.
      assert.equal(spy.showModalCalls, 0)
      assert.equal(dialog.open, false)
      assert.equal(isThreadAwaitingAttention('focused'), true)
    })

    it('surfaces the deferred prompt when the window is restored', () => {
      setVisibility('hidden')
      emit({ id: 'a', threadId: 'focused' })
      assert.equal(spy.showModalCalls, 0)

      // Restoring the window must pop the prompt without a thread switch.
      setVisibility('visible')

      assert.equal(spy.showModalCalls, 1)
      assert.equal(dialog.open, true)
      assert.equal(isThreadAwaitingAttention('focused'), false)
    })

    it('also defers a no-threadId prompt while hidden and shows it on restore', () => {
      setVisibility('hidden')
      emit({ id: 'a' })
      assert.equal(spy.showModalCalls, 0)
      assert.equal(dialog.open, false)

      setVisibility('visible')
      assert.equal(spy.showModalCalls, 1)
      assert.equal(dialog.open, true)
    })
  })
})
