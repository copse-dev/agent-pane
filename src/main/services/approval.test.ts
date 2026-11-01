import { describe, it, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import {
  runWithApprovalToolCallId,
  runWithBridgeExecutionId,
} from './approval-tool-call-context.ts'
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
  discardApprovalsForThread,
  parkedApprovalCount,
  pendingApprovalCountForThread,
  pendingApprovalParkedToolCallIds,
  releaseParkedApprovalsForThread,
  requestApproval,
  runWithApprovalHandler,
  setApprovalClockForTest,
  setApprovalHandler,
  trackAcpPermissionToolCall,
  supportsInteractiveClientApproval,
  type ApprovalRequest,
  type ApprovalResponse,
} from './approval.ts'
import {
  createAgentInitiatedTurnLease,
  type AgentInitiatedTurnClaim,
} from './acp/agent-initiated-turn.ts'
import { AcpTurnEnded } from './acp/turn-end.ts'
import { readDecisionLog } from './security/decision-log-store.ts'
import { NeedsInputBadge } from './needs-input-badge.ts'
import {
  registerRunDeadline,
  clearRunDeadline,
  resetRunDeadlinesForTest,
} from './hooks/run-deadline.ts'
import { runWithActiveRunIdentity } from './thread-models.ts'
import { runWithThreadExecutionContext } from './thread-execution-context.ts'
import { storageSet } from './storage/storage.ts'
import { drainWriteQueue } from './storage/write-queue.ts'

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

  it('denies and dismisses a safety prompt at its deadline, ignoring a late approval', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let promptSignal: AbortSignal | undefined
    let answer: (response: ApprovalResponse) => void = () => {}
    setApprovalHandler((_request, signal) => {
      promptSignal = signal
      return new Promise<ApprovalResponse>((resolve) => {
        answer = resolve
      })
    })
    const timed = { ...req, timeoutMs: 120_000 }
    const first = requestUnderThread(timed)
    const duplicate = requestUnderThread(timed)
    t.mock.timers.tick(119_999)
    assert.equal(promptSignal?.aborted, false)
    runWithActiveRunIdentity(THREAD, () => {
      t.mock.timers.tick(1)
    })
    const denial = { approved: false, remember: false, resolution: 'timeout' }
    assert.deepEqual(await first, denial)
    assert.deepEqual(await duplicate, denial)
    assert.equal(promptSignal.aborted, true)
    assert.equal(pendingApprovalCountForThread(THREAD), 0)
    answer({ approved: true, remember: true })
    await Promise.resolve()
    t.mock.timers.reset()
    await drainWriteQueue()
    const events = await readDecisionLog(PROJECT)
    assert.equal(events.at(-1)?.verdict, 'timeout')
    assert.equal(events.at(-1)?.actor, 'system')
  })

  it('keeps ordinary prompts pending past the safety timeout', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let signal: AbortSignal | undefined
    setApprovalHandler((_request, nextSignal) => {
      signal = nextSignal
      return new Promise(() => {})
    })
    const controller = new AbortController()
    const pending = requestUnderThread(req, controller.signal)
    t.mock.timers.tick(240_000)
    assert.equal(signal?.aborted, false)
    assert.equal(pendingApprovalCountForThread(THREAD), 1)
    controller.abort()
    assert.equal((await pending).approved, false)
    assert.equal(signal.aborted, true)
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

  it('records phone approval attribution without a remembered policy grant', async () => {
    setApprovalHandler(async () => ({
      approved: true,
      remember: false,
      grantScope: 'once',
      device: { id: 'device-id', label: 'My phone' },
    }))
    storageSet('activeProjectId', 'another-project')
    await runWithThreadExecutionContext(
      {
        projectId: PROJECT,
        threadId: THREAD,
        projectRoot: auditRoot,
        root: auditRoot,
        checkoutMode: 'shared',
        branch: null,
      },
      () => requestUnderThread(req),
    )
    const event = (await readDecisionLog(PROJECT)).at(-1)
    assert.equal(event?.actor, 'mobile-device')
    assert.equal(event.source, 'mobile:device-id (My phone)')
    assert.equal(event.remembered, false)
  })

  it('reverts to denying once the handler is cleared', async () => {
    setApprovalHandler(async () => ({ approved: true, remember: false }))
    assert.equal((await requestUnderThread(req)).approved, true)
    setApprovalHandler(null)
    assert.equal((await requestUnderThread(req)).approved, false)
  })

  it('releases the needs-input badge when a waiting thread is deleted', async () => {
    // initApproval holds the Dock badge while its prompt is open and releases
    // it when the prompt's signal aborts, so thread deletion has to reach that
    // signal for a live (not parked) waiter.
    const shown: number[] = []
    const badge = new NeedsInputBadge(
      (count) => shown.push(count),
      () => true,
    )
    setApprovalHandler(
      (_req, signal) =>
        new Promise<ApprovalResponse>((resolve) => {
          const release = badge.hold(THREAD)
          signal?.addEventListener(
            'abort',
            () => {
              release()
              resolve({ approved: false, remember: false })
            },
            { once: true },
          )
        }),
    )
    const pending = requestUnderThread(req)
    await Promise.resolve()
    assert.deepEqual(shown, [1])

    assert.equal(discardApprovalsForThread(THREAD), 1)
    assert.equal((await pending).approved, false)
    assert.deepEqual(shown, [1, 0])
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

  it('persists bridged identity and captures context before the handler settles', async () => {
    setApprovalHandler(async () => ({ approved: true, remember: false }))
    const shellContext = {
      sandboxAvailable: false,
      autoRunEnabled: true,
      workspaceTrusted: false,
      guardedYolo: false,
      networkScopeActive: false,
    }
    await runWithApprovalToolCallId('bridged-call', () =>
      requestUnderThread({
        ...req,
        subject: 'shell command (arguments omitted)',
        shellContext,
      }),
    )
    const event = (await readDecisionLog(PROJECT)).at(-1)
    assert.ok(event)
    assert.equal(event.toolCallId, 'bridged-call')
    const detail = readFileSync(
      join(auditRoot, PROJECT, THREAD, 'blobs', `decision-${event.id}.detail.json`),
      'utf8',
    )
    assert.ok(detail.includes(JSON.stringify(shellContext)))
    assert.ok(!detail.includes(req.body))
  })

  it('keeps every bridge execution linked when identical prompts coalesce', async () => {
    let answer: (response: ApprovalResponse) => void = () => {}
    const prompts: ApprovalRequest[] = []
    setApprovalHandler((request) => {
      prompts.push(request)
      return new Promise<ApprovalResponse>((resolve) => {
        answer = resolve
      })
    })
    const first = runWithBridgeExecutionId('bridge-first', () => requestUnderThread(req))
    const second = runWithBridgeExecutionId('bridge-second', () => requestUnderThread(req))
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0]?.bridgeExecutionId, 'bridge-first')
    answer({ approved: true, remember: false })
    await Promise.all([first, second])
    const event = (await readDecisionLog(PROJECT)).at(-1)
    assert.ok(event)
    assert.equal(event.bridgeExecutionId, undefined)
    assert.equal(event.toolCallId, undefined)
    const detail = readFileSync(
      join(auditRoot, PROJECT, THREAD, 'blobs', `decision-${event.id}.detail.json`),
      'utf8',
    )
    assert.ok(detail.includes('"bridgeExecutionIds":["bridge-first","bridge-second"]'))
  })

  it('preserves bridge identity on cancellation outside the originating async context', async () => {
    const abort = new AbortController()
    setApprovalHandler(() => new Promise(() => {}))
    const pending = runWithBridgeExecutionId('bridge-cancelled', () =>
      requestUnderThread(req, abort.signal),
    )
    abort.abort()
    await pending
    const event = (await readDecisionLog(PROJECT)).at(-1)
    assert.equal(event?.bridgeExecutionId, 'bridge-cancelled')
    assert.equal(event.source, 'aborted')
    assert.equal(event.toolCallId, undefined)
  })

  it('does not attribute a shared approval to the caller that cancelled', async () => {
    let answer: (response: ApprovalResponse) => void = () => {}
    setApprovalHandler(
      () =>
        new Promise<ApprovalResponse>((resolve) => {
          answer = resolve
        }),
    )
    const abort = new AbortController()
    const first = runWithBridgeExecutionId('cancelled-owner', () =>
      requestUnderThread(req, abort.signal),
    )
    const second = runWithBridgeExecutionId('remaining-owner', () => requestUnderThread(req))
    abort.abort()
    await first
    answer({ approved: true, remember: false })
    await second
    const events = await readDecisionLog(PROJECT)
    assert.ok(
      events.some(
        (event) => event.bridgeExecutionId === 'cancelled-owner' && event.verdict === 'cancelled',
      ),
    )
    assert.equal(events.at(-1)?.bridgeExecutionId, 'remaining-owner')
    assert.equal(events.at(-1)?.verdict, 'approved')
  })

  it('records the new bridge execution when an abandoned verdict is replayed', async () => {
    let answer: (response: ApprovalResponse) => void = () => {}
    setApprovalHandler(
      () =>
        new Promise<ApprovalResponse>((resolve) => {
          answer = resolve
        }),
    )
    const abort = new AbortController()
    const first = runWithBridgeExecutionId('bridge-abandoned', () =>
      requestUnderThread(req, abort.signal),
    )
    abort.abort(new AbandonedCallAbort('client timeout'))
    await assert.rejects(first, ApprovalPendingError)
    answer({ approved: true, remember: false })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const result = await runWithBridgeExecutionId('bridge-retry', () => requestUnderThread(req))
    assert.equal(result.approved, true)
    const events = await readDecisionLog(PROJECT)
    assert.ok(
      events.some(
        (event) => event.bridgeExecutionId === 'bridge-abandoned' && event.verdict === 'approved',
      ),
    )
    const replay = events.at(-1)
    assert.equal(replay?.bridgeExecutionId, 'bridge-retry')
    assert.equal(replay.source, 'abandoned-call-replay')
  })

  it('records explicit identity on unavailable and cancelled approvals', async () => {
    setApprovalHandler(null)
    await runWithApprovalToolCallId('ambient', () =>
      requestUnderThread({ ...req, toolCallId: 'explicit' }),
    )
    const controller = new AbortController()
    setApprovalHandler(() => new Promise(() => {}))
    const pending = runWithApprovalToolCallId('cancelled-call', () =>
      requestUnderThread(req, controller.signal),
    )
    controller.abort()
    await pending
    const events = await readDecisionLog(PROJECT)
    assert.equal(events.at(-2)?.toolCallId, 'explicit')
    assert.equal(events.at(-2)?.source, 'unavailable')
    assert.equal(events.at(-1)?.toolCallId, 'cancelled-call')
    assert.equal(events.at(-1)?.source, 'aborted')
  })

  it('keeps every coalesced tool identity in one prompt audit record', async () => {
    const gate = Promise.withResolvers<ApprovalResponse>()
    setApprovalHandler(() => gate.promise)
    const a = requestUnderThread({ ...req, toolCallId: 'first' })
    const b = requestUnderThread({ ...req, toolCallId: 'second' })
    gate.resolve({ approved: true, remember: false })
    await Promise.all([a, b])
    const events = await readDecisionLog(PROJECT)
    assert.equal(events.length, 1)
    const event = events[0]
    assert.ok(event)
    const detail = readFileSync(
      join(auditRoot, PROJECT, THREAD, 'blobs', `decision-${event.id}.detail.json`),
      'utf8',
    )
    assert.ok(detail.includes('"toolCallIds":["first","second"]'))
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

  it('requires separate answers for identical standalone consent requests', async () => {
    const pending: Array<(response: ApprovalResponse) => void> = []
    setApprovalHandler(() => new Promise((resolve) => pending.push(resolve)))
    const first = requestApproval({ ...req, standalone: true })
    const second = requestApproval({ ...req, standalone: true })
    assert.equal(pending.length, 2)
    pending[0]?.({ approved: true, remember: false })
    pending[1]?.({ approved: false, remember: false })
    assert.deepEqual(await Promise.all([first, second]), [
      { approved: true, remember: false },
      { approved: false, remember: false },
    ])
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

  it('pauses the active run deadlines while the prompt is open', async () => {
    const threadId = 'approval-pause-thread'
    const events: string[] = []
    const deadline = {
      pauseForHostWait: (): void => {
        events.push('pause')
      },
      resumeForHostWait: (): void => {
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
        standalone: false,
      }),
    )
  })

  it('never deduplicates standalone consent with ordinary approval', () => {
    const request = { title: 'Connect client', body: 'Code', type: 'mcp' } satisfies Parameters<
      typeof approvalDedupeKey
    >[0]
    assert.notEqual(approvalDedupeKey(request), approvalDedupeKey({ ...request, standalone: true }))
  })

  it('keeps different visible grant actions from sharing an answer', () => {
    assert.notEqual(
      approvalDedupeKey({
        title: 'Read access',
        body: 'cat notes',
        type: 'shell',
        approveLabel: 'Run once',
      }),
      approvalDedupeKey({
        title: 'Read access',
        body: 'cat notes',
        type: 'shell',
        approveLabel: 'Allow reads for this chat',
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
    // Detachment is auditable, but no denial is invented.
    const events = await readDecisionLog(PROJECT)
    assert.equal(events.length, logged + 1)
    assert.equal(events.at(-1)?.verdict, 'requested')
    assert.equal(events.at(-1)?.source, 'client-abandoned')
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

    const retry = await requestUnderThread({ ...req, toolCallId: 'replayed-call' })
    assert.equal(retry.approved, true)
    assert.equal(handlerCalls, 1, 'the retry must not open a second prompt')

    const events = await readDecisionLog(PROJECT)
    assert.equal(events.at(-1)?.toolCallId, 'replayed-call')
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

  it('keeps a parked prompt open through turn-end cleanup; the answer waits for the retry', async () => {
    parkingHandler()
    const controller = new AbortController()
    const first = requestUnderThread(req, controller.signal)
    await Promise.resolve()
    // The production race: the turn's own abort (controller.signal — the
    // signal the turn is torn down with) fires while carrying the bridge's
    // abandonment sentinel, so the waiter parks a stand-in *and* is still
    // sitting in the entry when cancelApprovalsForThread runs a tick later.
    controller.abort(new AbandonedCallAbort('client gave up'))
    await assert.rejects(first, ApprovalPendingError)
    assert.equal(parkedApprovalCount(), 1)
    assert.equal(cancelApprovalsForThread(THREAD), 0)
    assert.equal(handlerSignal?.aborted, false)
    assert.equal(parkedApprovalCount(), 1)

    release?.({ approved: true, remember: false, resolution: 'user' })
    await Promise.resolve()
    assert.equal(parkedApprovalCount(), 0)
    const retry = await requestUnderThread({ ...req, toolCallId: 'replayed-call' })
    assert.equal(retry.approved, true)
    assert.equal(handlerCalls, 1, 'the retry reuses the answer without prompting again')
  })

  for (const firstAbort of ['turn', 'client']) {
    it(`preserves the question when ${firstAbort} ends first, without running an orphaned caller`, async () => {
      parkingHandler()
      const turn = new AbortController()
      const client = new AbortController()
      const signal = AbortSignal.any([turn.signal, client.signal])
      const pending = requestUnderThread(req, signal)
      if (firstAbort === 'turn') {
        turn.abort(new AcpTurnEnded('completed'))
        client.abort(new AbandonedCallAbort('client disconnected'))
      } else {
        client.abort(new AbandonedCallAbort('client disconnected'))
        turn.abort(new AcpTurnEnded('completed'))
      }
      cancelApprovalsForThread(THREAD)
      releaseParkedApprovalsForThread(THREAD)
      await assert.rejects(pending, ApprovalPendingError)
      assert.equal(handlerSignal?.aborted, false)
      assert.equal(parkedApprovalCount(), 1)
      const events = await readDecisionLog(PROJECT)
      assert.equal(events.at(-1)?.verdict, 'requested')
      assert.equal(
        events.at(-1)?.source,
        firstAbort === 'turn' ? 'turn-completed' : 'client-abandoned',
      )
      release?.({ approved: true, remember: false, resolution: 'user' })
      await Promise.resolve()
      assert.equal((await requestUnderThread(req)).approved, true)
      assert.equal(handlerCalls, 1)
      // The stored answer is consumed once; the next request opens a new prompt.
      const next = requestUnderThread(req)
      assert.equal(handlerCalls, 2)
      release?.({ approved: false, remember: false })
      assert.equal((await next).approved, false)
    })
  }

  it('Stop revokes a parked prompt even after its run identity has been released', async () => {
    parkingHandler()
    const controller = new AbortController()
    const pending = requestUnderThread(req, controller.signal)
    controller.abort(new AcpTurnEnded('completed'))
    await assert.rejects(pending, ApprovalPendingError)
    releaseParkedApprovalsForThread(THREAD)
    assert.equal(discardApprovalsForThread(THREAD, 'stopped'), 1)
    assert.equal(handlerSignal?.aborted, true)
    assert.equal(parkedApprovalCount(), 0)
    // A late IPC answer to the dismissed prompt must not create a replay grant.
    release?.({ approved: true, remember: false, resolution: 'user' })
    await Promise.resolve()
    const next = requestUnderThread(req)
    assert.equal(handlerCalls, 2)
    release?.({ approved: false, remember: false })
    assert.equal((await next).approved, false)
    const events = await readDecisionLog(PROJECT)
    assert.ok(events.some((event) => event.source === 'stopped' && event.verdict === 'cancelled'))
  })

  it('never replays consent to changed bridge arguments even when the prompt copy is identical', async () => {
    parkingHandler()
    const requestOperation = (command: string, signal?: AbortSignal): Promise<ApprovalResponse> =>
      runWithBridgeExecutionId('operation-' + command, () => requestUnderThread(req, signal), {
        toolName: 'run_shell',
        arguments: { command },
      })
    const { signal, abandon } = abandonedSignal()
    const pending = requestOperation('original', signal)
    abandon()
    await assert.rejects(pending, ApprovalPendingError)
    release?.({ approved: true, remember: false })
    await Promise.resolve()
    const different = requestOperation('changed')
    assert.equal(handlerCalls, 2, 'changed arguments require a fresh decision')
    release?.({ approved: false, remember: false })
    assert.equal((await different).approved, false)
    assert.equal((await requestOperation('original')).approved, true)
    assert.equal(handlerCalls, 2, 'only the exact operation can consume the stored answer')
  })

  it('does not replay a window-closed response as a human denial', async () => {
    parkingHandler()
    const { signal, abandon } = abandonedSignal()
    const pending = requestUnderThread(req, signal)
    abandon()
    await assert.rejects(pending, ApprovalPendingError)
    release?.({ approved: false, remember: false, resolution: 'window-closed' })
    await Promise.resolve()
    const next = requestUnderThread(req)
    assert.equal(handlerCalls, 2)
    release?.({ approved: false, remember: false })
    assert.equal((await next).approved, false)
  })

  it('Stop revokes an already answered detached prompt before an identical retry', async () => {
    parkingHandler()
    const { signal, abandon } = abandonedSignal()
    const pending = requestUnderThread(req, signal)
    abandon()
    await assert.rejects(pending, ApprovalPendingError)
    release?.({ approved: true, remember: false, resolution: 'user' })
    await Promise.resolve()
    discardApprovalsForThread(THREAD, 'stopped')
    const next = requestUnderThread(req)
    assert.equal(handlerCalls, 2)
    release?.({ approved: false, remember: false })
    assert.equal((await next).approved, false)
  })

  for (const reason of ['completed', 'stopped', 'idle-timeout', 'session-closed'] as const) {
    it(`uses the real self-started lease's ${reason} reason at the approval boundary`, async () => {
      parkingHandler()
      let turnSignal: AbortSignal | null = null
      let binding: Promise<string | null> | null = null
      const lease = createAgentInitiatedTurnLease({
        projectId: PROJECT,
        threadId: THREAD,
        bridge: {
          setExecutionContext: () => {},
          setTurnSignal: (next) => {
            turnSignal = next
          },
          setPendingExecutionContext: (next) => {
            binding = next
          },
        },
        resolveContext: () => Promise.resolve('context'),
        confirmContinue: () => Promise.resolve(false),
        beginWriter: (): (() => void) => (): void => {},
        getAuthority: () => ({
          claimAgentInitiatedTurn: (): Promise<AgentInitiatedTurnClaim> =>
            Promise.resolve({ status: 'granted', release: (): Promise<void> => Promise.resolve() }),
        }),
      })
      const currentSignal = (): AbortSignal | null => turnSignal
      lease.begin()
      try {
        const currentBinding = (): Promise<string | null> | null => binding
        assert.equal(await currentBinding(), 'context')
        const signal = currentSignal()
        assert.ok(signal)
        const pending = requestUnderThread(req, signal)
        lease.end(reason)
        if (reason === 'completed') {
          await assert.rejects(pending, ApprovalPendingError)
          assert.equal(handlerSignal?.aborted, false)
          release?.({ approved: true, remember: false })
          await Promise.resolve()
          assert.equal((await requestUnderThread(req)).approved, true)
        } else {
          assert.equal((await pending).approved, false)
          assert.equal(handlerSignal?.aborted, true)
          const events = await readDecisionLog(PROJECT)
          assert.equal(events.at(-1)?.source, reason)
        }
      } finally {
        lease.end('stopped')
      }
    })
  }

  it('discards a parked prompt when its thread is deleted', async () => {
    parkingHandler()
    const { signal, abandon } = abandonedSignal()
    const first = requestUnderThread(req, signal)
    await Promise.resolve()
    abandon()
    await assert.rejects(first, ApprovalPendingError)

    assert.equal(discardApprovalsForThread(THREAD), 1)
    assert.equal(parkedApprovalCount(), 0)
    assert.equal(handlerSignal?.aborted, true)
  })

  it('releaseParkedApprovalsForThread detaches the stand-in without closing the prompt', async () => {
    parkingHandler()
    const { signal, abandon } = abandonedSignal()
    const first = requestUnderThread(req, signal)
    await Promise.resolve()
    abandon()
    await assert.rejects(first, ApprovalPendingError)
    releaseParkedApprovalsForThread(THREAD)
    assert.equal(pendingApprovalCountForThread(THREAD), 0)
    assert.equal(parkedApprovalCount(), 1, 'the prompt itself is still up')
    assert.equal(handlerSignal?.aborted, false)

    release?.({ approved: true, remember: false, resolution: 'user' })
    await Promise.resolve()
    // The ledger key carries the same thread id, so that thread's identical
    // retry still claims the answer.
    assert.equal((await requestUnderThread(req)).approved, true)
    assert.equal(handlerCalls, 1)
  })

  it('attributes a parked stand-in to its tool call id for turn bookkeeping', async () => {
    parkingHandler()
    const { signal, abandon } = abandonedSignal()
    const first = runWithActiveRunIdentity(THREAD, () =>
      requestApproval({ ...req, toolCallId: 'call-42' }, signal),
    )
    await Promise.resolve()
    abandon()
    await assert.rejects(first, ApprovalPendingError)
    assert.deepEqual([...pendingApprovalParkedToolCallIds(THREAD)], ['call-42'])
    release?.({ approved: true, remember: false })
    await Promise.resolve()
    assert.deepEqual([...pendingApprovalParkedToolCallIds(THREAD)], [])
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

describe('paired approval capabilities', () => {
  it('requires explicit one-request certification for preparation rather than trusting its title or label', () => {
    const preparation: ApprovalRequest = {
      title: 'Prepare this worktree?',
      body: 'Install dependencies and run reviewed setup',
      type: 'shell',
      subject: 'prepare_worktree',
      allowRemember: false,
    }
    assert.equal(supportsInteractiveClientApproval(preparation), false)
    const bounded: ApprovalRequest = { ...preparation, interactiveClientApproval: 'once' }
    assert.equal(supportsInteractiveClientApproval(bounded), true)
    assert.equal(supportsInteractiveClientApproval({ ...bounded, allowRemember: true }), false)
    const unspecifiedRemember: ApprovalRequest = { ...bounded }
    delete unspecifiedRemember.allowRemember
    assert.equal(supportsInteractiveClientApproval(unspecifiedRemember), false)
    assert.equal(
      supportsInteractiveClientApproval({ ...bounded, turnTreeLeaseDefault: true }),
      false,
    )
    assert.equal(supportsInteractiveClientApproval({ ...preparation, type: 'mcp' }), false)
  })
})
