import { describe, it, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ABANDONED_VERDICT_TTL_MS,
  AbandonedCallAbort,
  ApprovalPendingError,
  approvalDedupeKey,
  cancelApprovalsForThread,
  cancelApprovalsForAcpToolCall,
  clearAbandonedVerdictsForTest,
  parkedApprovalCount,
  pendingApprovalCountForThread,
  requestApproval,
  runWithApprovalHandler,
  setApprovalClockForTest,
  setApprovalHandler,
  trackAcpPermissionToolCall,
  type ApprovalRequest,
  type ApprovalResponse,
} from './approval.ts'
import { readDecisionLog } from './security/decision-log-store.ts'
import {
  registerRunDeadline,
  clearRunDeadline,
  resetRunDeadlinesForTest,
} from './hooks/run-deadline.ts'
import { runWithActiveRunIdentity } from './thread-models.ts'
import { storageSet } from './storage/storage.ts'

const PROJECT = 'proj-approval'
const THREAD = 't-approval'
const req: ApprovalRequest = { title: 'Run shell', body: 'rm -rf build', type: 'shell' }

async function requestUnderThread(
  request: ApprovalRequest,
  signal?: AbortSignal,
): Promise<ApprovalResponse> {
  return runWithActiveRunIdentity(THREAD, () => requestApproval(request, signal))
}

describe('requestApproval pluggable transport', () => {
  let auditRoot: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    auditRoot = mkdtempSync(join(tmpdir(), 'copse-approval-audit-'))
    process.env['COPSE_WORKSPACE_DIR'] = auditRoot
    storageSet('activeProjectId', PROJECT)
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
    assert.deepEqual(await requestUnderThread(req), {
      approved: false,
      remember: false,
      resolution: 'unavailable',
    })
    const events = await readDecisionLog(PROJECT)
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
    assert.deepEqual(await requestUnderThread(req), { approved: true, remember: true })
    assert.deepEqual(seen, [req])
  })

  it('reverts to denying once the handler is cleared', async () => {
    setApprovalHandler(async () => ({ approved: true, remember: false }))
    assert.equal((await requestUnderThread(req)).approved, true)
    setApprovalHandler(null)
    assert.equal((await requestUnderThread(req)).approved, false)
  })

  it('returns denied immediately when the signal is already aborted', async () => {
    let called = false
    setApprovalHandler(async () => {
      called = true
      return { approved: true, remember: false }
    })
    assert.deepEqual(await requestUnderThread(req, AbortSignal.abort()), {
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
    const pending = requestUnderThread(req, controller.signal)
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
    await requestUnderThread(req)
    setApprovalHandler(async () => ({
      approved: false,
      remember: false,
      resolution: 'window-closed',
    }))
    await requestUnderThread(req)

    const events = await readDecisionLog(PROJECT)
    assert.deepEqual(
      events.slice(-2).map(({ actor, verdict, source }) => ({ actor, verdict, source })),
      [
        { actor: 'system', verdict: 'timeout', source: 'timeout' },
        { actor: 'system', verdict: 'cancelled', source: 'window-closed' },
      ],
    )
  })

  it("records a request's reasons alongside the answer", async () => {
    setApprovalHandler(async () => ({ approved: true, remember: true }))
    await requestUnderThread({
      ...req,
      subject: 'shell command (arguments omitted)',
      scope: 'external-read',
      reasons: ['reads outside the project: ~/.copse'],
    })

    const event = (await readDecisionLog(PROJECT)).at(-1)
    assert.ok(event)
    // The durable line omits the command, so its reasons are the only record of
    // what the user actually widened access to.
    assert.deepEqual(event.reasons, ['reads outside the project: ~/.copse'])
    assert.equal(event.scope, 'external-read')
    assert.equal(event.remembered, true)
  })

  it('omits reasons from the log when the request carries none', async () => {
    setApprovalHandler(async () => ({ approved: true, remember: false }))
    await requestUnderThread(req)
    assert.equal((await readDecisionLog(PROJECT)).at(-1)?.reasons, undefined)
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

  it('does not coalesce requests that differ in advice or footer', async () => {
    const pending: Array<(response: ApprovalResponse) => void> = []
    setApprovalHandler(
      (request) =>
        new Promise((resolve) => {
          assert.equal(request.body, req.body)
          pending.push(resolve)
        }),
    )

    const first = requestApproval({ ...req, bodyAdvice: 'First warning' })
    const second = requestApproval({ ...req, bodyAdvice: 'Second warning' })
    const third = requestApproval({ ...req, bodyFooter: 'Different question' })

    assert.equal(pending.length, 3)
    for (const resolve of pending) resolve({ approved: false, remember: false })
    await Promise.all([first, second, third])
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

describe('abandoned calls (parked prompts and verdict replay)', () => {
  let auditRoot: string
  let previousRoot: string | undefined
  let handlerCalls = 0
  let handlerSignal: AbortSignal | undefined
  let release: ((response: ApprovalResponse) => void) | undefined

  function parkingHandler(): void {
    setApprovalHandler(
      (_req, signal) =>
        new Promise((resolve) => {
          handlerCalls++
          handlerSignal = signal
          release = resolve
        }),
    )
  }

  /** The bridge's abandonment: a merged signal whose first abort carries the sentinel. */
  function abandonedSignal(): { signal: AbortSignal; abandon: () => void } {
    const call = new AbortController()
    const turn = new AbortController()
    return {
      signal: AbortSignal.any([turn.signal, call.signal]),
      abandon: (): void => {
        call.abort(new AbandonedCallAbort('client gave up'))
      },
    }
  }

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    auditRoot = mkdtempSync(join(tmpdir(), 'copse-approval-abandon-'))
    process.env['COPSE_WORKSPACE_DIR'] = auditRoot
    storageSet('activeProjectId', PROJECT)
    handlerCalls = 0
    handlerSignal = undefined
    release = undefined
  })

  afterEach(() => {
    setApprovalHandler(null)
    setApprovalClockForTest(null)
    clearAbandonedVerdictsForTest()
    resetRunDeadlinesForTest()
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(auditRoot, { recursive: true, force: true })
  })

  it('keeps the prompt open and tells the caller to retry when its call is abandoned', async () => {
    parkingHandler()
    const logged = (await readDecisionLog(PROJECT)).length
    const { signal, abandon } = abandonedSignal()
    const pending = requestUnderThread(req, signal)
    await Promise.resolve()
    abandon()
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof ApprovalPendingError)
      assert.match(error.message, /still pending/)
      assert.match(error.message, /Retry the exact same call/)
      assert.match(error.message, /10 minutes/)
      return true
    })
    // The prompt itself was NOT cancelled…
    assert.equal(handlerSignal?.aborted, false)
    assert.equal(parkedApprovalCount(), 1)
    assert.equal(pendingApprovalCountForThread(THREAD), 1)
    // …and no denial was invented for the audit log.
    assert.equal((await readDecisionLog(PROJECT)).length, logged)
  })

  it('replays the eventual verdict to an identical retry without prompting again', async () => {
    parkingHandler()
    const { signal, abandon } = abandonedSignal()
    const first = requestUnderThread(req, signal)
    await Promise.resolve()
    abandon()
    await assert.rejects(first, ApprovalPendingError)

    release?.({ approved: true, remember: false, resolution: 'user' })
    await Promise.resolve()
    assert.equal(parkedApprovalCount(), 0)

    const retry = await requestUnderThread(req)
    assert.equal(retry.approved, true)
    assert.equal(handlerCalls, 1, 'the retry must not open a second prompt')

    const events = await readDecisionLog(PROJECT)
    assert.deepEqual(
      events.slice(-2).map((event) => [event.verdict, event.source ?? 'user']),
      [
        ['approved', 'user'],
        ['approved', 'abandoned-call-replay'],
      ],
    )
  })

  it('replays a denial too, so the agent does not re-ask a question the user refused', async () => {
    parkingHandler()
    const { signal, abandon } = abandonedSignal()
    const first = requestUnderThread(req, signal)
    await Promise.resolve()
    abandon()
    await assert.rejects(first, ApprovalPendingError)
    release?.({ approved: false, remember: false, resolution: 'user' })
    await Promise.resolve()
    assert.deepEqual(await requestUnderThread(req), {
      approved: false,
      remember: false,
      resolution: 'user',
    })
    assert.equal(handlerCalls, 1)
  })

  it('serves a stored verdict once', async () => {
    parkingHandler()
    const { signal, abandon } = abandonedSignal()
    const first = requestUnderThread(req, signal)
    await Promise.resolve()
    abandon()
    await assert.rejects(first, ApprovalPendingError)
    release?.({ approved: true, remember: false })
    await Promise.resolve()
    assert.equal((await requestUnderThread(req)).approved, true)
    // A second identical request is a fresh question.
    const again = requestUnderThread(req)
    await Promise.resolve()
    assert.equal(handlerCalls, 2)
    release?.({ approved: false, remember: false })
    assert.equal((await again).approved, false)
  })

  it('joins the still-open prompt when the retry arrives before the user answers', async () => {
    parkingHandler()
    const { signal, abandon } = abandonedSignal()
    const first = requestUnderThread(req, signal)
    await Promise.resolve()
    abandon()
    await assert.rejects(first, ApprovalPendingError)

    const retry = requestUnderThread(req)
    await Promise.resolve()
    assert.equal(handlerCalls, 1)
    assert.equal(parkedApprovalCount(), 0, 'the live retry replaces the stand-in')
    release?.({ approved: true, remember: false })
    assert.equal((await retry).approved, true)
    // The retry consumed the live prompt, so nothing is left to replay to a
    // third call: one answer, one run.
    const third = requestUnderThread(req)
    await Promise.resolve()
    assert.equal(handlerCalls, 2)
    release?.({ approved: false, remember: false })
    await third
  })

  it('forgets a verdict older than the replay window', async () => {
    let now = 1_000_000
    setApprovalClockForTest(() => now)
    parkingHandler()
    const { signal, abandon } = abandonedSignal()
    const first = requestUnderThread(req, signal)
    await Promise.resolve()
    abandon()
    await assert.rejects(first, ApprovalPendingError)
    release?.({ approved: true, remember: false })
    await Promise.resolve()

    now += ABANDONED_VERDICT_TTL_MS + 1
    const retry = requestUnderThread(req)
    await Promise.resolve()
    assert.equal(handlerCalls, 2, 'an expired verdict must prompt afresh')
    release?.({ approved: false, remember: false })
    assert.equal((await retry).approved, false)
  })

  it('scopes a stored verdict to the thread and the request that earned it', async () => {
    parkingHandler()
    const { signal, abandon } = abandonedSignal()
    const first = requestUnderThread(req, signal)
    await Promise.resolve()
    abandon()
    await assert.rejects(first, ApprovalPendingError)
    release?.({ approved: true, remember: false })
    await Promise.resolve()

    const otherThread = runWithActiveRunIdentity('t-other', () => requestApproval(req))
    await Promise.resolve()
    assert.equal(handlerCalls, 2, 'another thread must not inherit the verdict')
    release?.({ approved: false, remember: false })
    await otherThread

    const otherCommand = requestUnderThread({ ...req, body: 'rm -rf dist' })
    await Promise.resolve()
    assert.equal(handlerCalls, 3, 'a different command must not inherit the verdict')
    release?.({ approved: false, remember: false })
    await otherCommand

    // The original thread's verdict is still there for the identical retry.
    assert.equal((await requestUnderThread(req)).approved, true)
    assert.equal(handlerCalls, 3)
  })

  it('treats a plain abort as a cancel, exactly as before', async () => {
    parkingHandler()
    const controller = new AbortController()
    const pending = requestUnderThread(req, controller.signal)
    await Promise.resolve()
    controller.abort()
    assert.deepEqual(await pending, { approved: false, remember: false })
    assert.equal(handlerSignal?.aborted, true)
    assert.equal(parkedApprovalCount(), 0)
  })

  it('still dismisses a parked prompt when the thread turn ends, storing nothing', async () => {
    parkingHandler()
    const { signal, abandon } = abandonedSignal()
    const first = requestUnderThread(req, signal)
    await Promise.resolve()
    abandon()
    await assert.rejects(first, ApprovalPendingError)
    assert.equal(cancelApprovalsForThread(THREAD), 1)
    assert.equal(handlerSignal?.aborted, true)
    assert.equal(parkedApprovalCount(), 0)
    // Whatever the torn-down handler returns now is not a user answer.
    release?.({ approved: true, remember: false })
    await Promise.resolve()
    const retry = requestUnderThread(req)
    await Promise.resolve()
    assert.equal(handlerCalls, 2)
    release?.({ approved: false, remember: false })
    await retry
  })

  it('does not park a request that no thread owns', async () => {
    parkingHandler()
    const { signal, abandon } = abandonedSignal()
    const pending = requestApproval(req, signal)
    await Promise.resolve()
    abandon()
    assert.deepEqual(await pending, { approved: false, remember: false })
    assert.equal(handlerSignal?.aborted, true)
    assert.equal(parkedApprovalCount(), 0)
  })
})
