import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  approvalDedupeKey,
  requestApproval,
  setApprovalHandler,
  startDockAttention,
  type ApprovalRequest,
  type DockAttention,
} from './approval.ts'
import {
  registerRunDeadline,
  clearRunDeadline,
  resetRunDeadlinesForTest,
} from './hooks/run-deadline.ts'
import { runWithActiveRunIdentity } from './thread-models.ts'

const req: ApprovalRequest = { title: 'Run shell', body: 'rm -rf build', type: 'shell' }

describe('requestApproval pluggable transport', () => {
  afterEach(() => {
    setApprovalHandler(null)
    resetRunDeadlinesForTest()
  })

  it('denies (without hanging) when no handler is registered', async () => {
    setApprovalHandler(null)
    assert.deepEqual(await requestApproval(req), { approved: false, remember: false })
  })

  it('routes the request to the registered handler', async () => {
    const seen: ApprovalRequest[] = []
    setApprovalHandler(async (r) => {
      seen.push(r)
      return { approved: true, remember: true }
    })
    assert.deepEqual(await requestApproval(req), { approved: true, remember: true })
    assert.deepEqual(seen, [req])
  })

  it('reverts to denying once the handler is cleared', async () => {
    setApprovalHandler(async () => ({ approved: true, remember: false }))
    assert.equal((await requestApproval(req)).approved, true)
    setApprovalHandler(null)
    assert.equal((await requestApproval(req)).approved, false)
  })

  it('returns denied immediately when the signal is already aborted', async () => {
    let called = false
    setApprovalHandler(async () => {
      called = true
      return { approved: true, remember: false }
    })
    assert.deepEqual(await requestApproval(req, AbortSignal.abort()), {
      approved: false,
      remember: false,
    })
    assert.equal(called, false)
  })

  it('passes the abort signal to the handler for in-flight cancellation', async () => {
    setApprovalHandler(async (_req, signal) => {
      assert.ok(signal)
      await waitForAbort(signal)
      return { approved: false, remember: false }
    })
    const controller = new AbortController()
    const pending = requestApproval(req, controller.signal)
    await Promise.resolve()
    controller.abort()
    assert.deepEqual(await pending, { approved: false, remember: false })
  })

  it('coalesces identical in-flight requests into one handler call', async () => {
    let handlerCalls = 0
    let release!: (response: { approved: boolean; remember: boolean }) => void
    setApprovalHandler(
      () =>
        new Promise((resolve) => {
          handlerCalls++
          release = resolve
        }),
    )
    const a = requestApproval(req)
    const b = requestApproval({ ...req })
    await Promise.resolve()
    assert.equal(handlerCalls, 1)
    release({ approved: true, remember: false })
    assert.deepEqual(await a, { approved: true, remember: false })
    assert.deepEqual(await b, { approved: true, remember: false })
    assert.equal(handlerCalls, 1)
  })

  it('does not coalesce requests that differ in body', async () => {
    let handlerCalls = 0
    setApprovalHandler(async () => {
      handlerCalls++
      return { approved: true, remember: false }
    })
    await Promise.all([
      requestApproval(req),
      requestApproval({ ...req, body: 'different command' }),
    ])
    assert.equal(handlerCalls, 2)
  })

  it('keeps the shared prompt open when only one coalesced waiter aborts', async () => {
    let handlerSignal: AbortSignal | undefined
    let release!: (response: { approved: boolean; remember: boolean }) => void
    setApprovalHandler(
      (_req, signal) =>
        new Promise((resolve) => {
          handlerSignal = signal
          release = resolve
        }),
    )
    const firstCtl = new AbortController()
    const first = requestApproval(req, firstCtl.signal)
    const second = requestApproval(req)
    await Promise.resolve()
    firstCtl.abort()
    assert.deepEqual(await first, { approved: false, remember: false })
    assert.equal(handlerSignal?.aborted, false)
    release({ approved: true, remember: true })
    assert.deepEqual(await second, { approved: true, remember: true })
  })

  it('pauses the active run idle deadline while the prompt is open', async () => {
    const threadId = 'approval-pause-thread'
    const events: string[] = []
    const deadline = {
      pause: (): void => {
        events.push('pause')
      },
      resume: (): void => {
        events.push('resume')
      },
    }
    registerRunDeadline(threadId, deadline)
    let release!: (response: { approved: boolean; remember: boolean }) => void
    setApprovalHandler(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const pending = runWithActiveRunIdentity(threadId, () => requestApproval(req))
    await Promise.resolve()
    assert.deepEqual(events, ['pause'])
    release({ approved: true, remember: false })
    assert.deepEqual(await pending, { approved: true, remember: false })
    assert.deepEqual(events, ['pause', 'resume'])
    clearRunDeadline(threadId, deadline)
  })

  it('approvalDedupeKey ignores undefined optional fields consistently', () => {
    assert.equal(
      approvalDedupeKey({ title: 't', body: 'b', type: 'shell' }),
      approvalDedupeKey({
        title: 't',
        body: 'b',
        type: 'shell',
        allowRemember: false,
        rememberLabel: '',
        showWhileSettingsOpen: false,
      }),
    )
  })
})

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener(
      'abort',
      () => {
        resolve()
      },
      { once: true },
    )
  })
}

describe('startDockAttention', () => {
  function fakeDock(): {
    dock: DockAttention
    calls: { bounce: Array<string | undefined>; cancel: number[] }
  } {
    const calls: { bounce: Array<string | undefined>; cancel: number[] } = {
      bounce: [],
      cancel: [],
    }
    const dock: DockAttention = {
      bounce(type) {
        calls.bounce.push(type)
        return 42
      },
      cancelBounce(id) {
        calls.cancel.push(id)
      },
    }
    return { dock, calls }
  }

  it('bounces critically on start and cancels that bounce on stop', () => {
    const { dock, calls } = fakeDock()
    const stop = startDockAttention(dock)
    assert.deepEqual(calls.bounce, ['critical'])
    assert.deepEqual(calls.cancel, [])
    stop()
    assert.deepEqual(calls.cancel, [42])
  })

  it('cancels at most once even if stopped repeatedly', () => {
    const { dock, calls } = fakeDock()
    const stop = startDockAttention(dock)
    stop()
    stop()
    assert.deepEqual(calls.cancel, [42])
  })

  it('is a no-op (no throw) when there is no dock', () => {
    const stop = startDockAttention(undefined)
    assert.doesNotThrow(stop)
  })
})
