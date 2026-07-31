import { describe, it, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  approvalDedupeKey,
  cancelApprovalsForThread,
  cancelApprovalsForAcpToolCall,
  pendingApprovalCountForThread,
  requestApproval,
  runWithApprovalHandler,
  setApprovalHandler,
  startDockAttention,
  trackAcpPermissionToolCall,
  type ApprovalRequest,
  type DockAttention,
} from './approval.ts'
import { readDecisionLog } from './security/decision-log-store.ts'
import {
  registerRunDeadline,
  clearRunDeadline,
  resetRunDeadlinesForTest,
} from './hooks/run-deadline.ts'
import { runWithActiveRunIdentity } from './thread-models.ts'

const req: ApprovalRequest = { title: 'Run shell', body: 'rm -rf build', type: 'shell' }

describe('requestApproval pluggable transport', () => {
  let auditRoot: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    auditRoot = mkdtempSync(join(tmpdir(), 'copse-approval-audit-'))
    process.env['COPSE_WORKSPACE_DIR'] = auditRoot
  })

  afterEach(() => {
    setApprovalHandler(null)
    resetRunDeadlinesForTest()
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(auditRoot, { recursive: true, force: true })
  })

  it('denies (without hanging) when no handler is registered', async () => {
    setApprovalHandler(null)
    assert.deepEqual(await requestApproval(req), {
      approved: false,
      remember: false,
      resolution: 'unavailable',
    })
    const events = await readDecisionLog('_global')
    assert.equal(events.at(-1)?.actor, 'system')
    assert.equal(events.at(-1)?.verdict, 'cancelled')
    assert.equal(events.at(-1)?.source, 'unavailable')
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

  it('distinguishes timeout and window closure from user denial in the audit log', async () => {
    setApprovalHandler(async () => ({
      approved: false,
      remember: false,
      resolution: 'timeout',
    }))
    await requestApproval(req)
    setApprovalHandler(async () => ({
      approved: false,
      remember: false,
      resolution: 'window-closed',
    }))
    await requestApproval(req)

    const events = await readDecisionLog('_global')
    assert.deepEqual(
      events.slice(-2).map(({ actor, verdict, source }) => ({ actor, verdict, source })),
      [
        { actor: 'system', verdict: 'timeout', source: 'timeout' },
        { actor: 'system', verdict: 'cancelled', source: 'window-closed' },
      ],
    )
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

  it('does not coalesce identical requests across scoped headless handlers', async () => {
    const handlers: string[] = []
    const first = runWithApprovalHandler(
      async () => {
        handlers.push('first')
        return { approved: true, remember: false }
      },
      () => requestApproval(req),
    )
    const second = runWithApprovalHandler(
      async () => {
        handlers.push('second')
        return { approved: false, remember: false }
      },
      () => requestApproval(req),
    )

    assert.deepEqual(await Promise.all([first, second]), [
      { approved: true, remember: false },
      { approved: false, remember: false },
    ])
    assert.deepEqual(handlers.sort(), ['first', 'second'])
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

  it('cancelApprovalsForThread dismisses waiters for that thread only', async () => {
    let releaseOther!: (response: { approved: boolean; remember: boolean }) => void
    setApprovalHandler(
      (req) =>
        new Promise((resolve) => {
          if (req.body === 'other-thread') releaseOther = resolve
        }),
    )
    const orphaned = runWithActiveRunIdentity('thread-ending', () =>
      requestApproval({ title: 'Run outside sandbox?', body: 'git submodule', type: 'shell' }),
    )
    const other = runWithActiveRunIdentity('thread-other', () =>
      requestApproval({ title: 'Run outside sandbox?', body: 'other-thread', type: 'shell' }),
    )
    await Promise.resolve()
    assert.equal(cancelApprovalsForThread('thread-ending'), 1)
    assert.deepEqual(await orphaned, { approved: false, remember: false })
    releaseOther({ approved: true, remember: false })
    assert.deepEqual(await other, { approved: true, remember: false })
  })

  it('cancelApprovalsForAcpToolCall aborts the tracked permission signal', async () => {
    const tracked = trackAcpPermissionToolCall('call-1')
    assert.equal(tracked.signal.aborted, false)
    assert.equal(cancelApprovalsForAcpToolCall('call-1'), true)
    assert.equal(tracked.signal.aborted, true)
    assert.equal(cancelApprovalsForAcpToolCall('call-1'), false)
    tracked.unregister()
  })

  it('pendingApprovalCountForThread reflects in-flight waiters', async () => {
    let release!: (response: { approved: boolean; remember: boolean }) => void
    setApprovalHandler(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const pending = runWithActiveRunIdentity('count-thread', () => requestApproval(req))
    await Promise.resolve()
    assert.equal(pendingApprovalCountForThread('count-thread'), 1)
    assert.equal(pendingApprovalCountForThread('other'), 0)
    release({ approved: true, remember: false })
    await pending
    assert.equal(pendingApprovalCountForThread('count-thread'), 0)
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

  it('is idempotent: a second stop is a no-op', () => {
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
