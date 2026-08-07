import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestApproval, setApprovalHandler } from './approval.ts'
import {
  beginDeferralMode,
  clearDeferralModesForTests,
  endDeferralMode,
} from './security/deferral-mode.ts'
import { readPendingDeferrals } from './security/deferred-approval-store.ts'
import { isDeferredApprovalError } from '@shared/threads/deferred-approval.ts'
import { runWithActiveRunIdentity } from './thread-models.ts'

/**
 * The interception itself: with a thread in deferral mode, a gate that would
 * open a modal instead queues the request and throws. Covered here rather than
 * in the store's own tests because the thing worth protecting is the *seam* —
 * every gate funnels through `requestApproval`, so this is what stops one of
 * them quietly prompting an empty room.
 */

const roots: string[] = []
const THREAD = 'deferral-interception-thread'

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'copse-defer-intercept-'))
  roots.push(root)
  process.env['COPSE_WORKSPACE_DIR'] = root
})

afterEach(() => {
  clearDeferralModesForTests()
  setApprovalHandler(null)
})

/** Run `fn` as if the agent loop were executing tools for THREAD. */
function asRun<T>(fn: () => Promise<T>): Promise<T> {
  return runWithActiveRunIdentity(THREAD, fn)
}

process.on('exit', () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const request = {
  title: 'Run outside sandbox?',
  body: 'git push origin main',
  type: 'shell' as const,
  subject: 'shell command (arguments omitted)',
  scope: 'external',
  cause: 'shell-sandbox-escalation' as const,
  reasons: ['git network operation'],
}

describe('deferral interception at the approval seam', () => {
  it('throws instead of prompting, and never opens the handler', async () => {
    let handlerCalls = 0
    setApprovalHandler(async () => {
      handlerCalls++
      return { approved: true, remember: false }
    })
    beginDeferralMode(THREAD)

    const error = await asRun(() =>
      requestApproval(request).then(
        () => null,
        (err: unknown) => err,
      ),
    )

    // A resolved value — even a denial — would let callers treat this as "the
    // user said no" and move on, dropping the request silently.
    assert.equal(isDeferredApprovalError(error), true)
    assert.equal(handlerCalls, 0, 'the modal must not be shown to an empty room')
  })

  it('tells the agent the action did not run and to carry on', async () => {
    setApprovalHandler(async () => ({ approved: true, remember: false }))
    beginDeferralMode(THREAD)

    const error = await asRun(() => requestApproval(request).catch((err: unknown) => err))
    const message = error instanceof Error ? error.message : ''
    assert.match(message, /NOT run/)
    assert.match(message, /continue with the other parts/i)
    assert.doesNotMatch(message, /try again/i)
  })

  it('leaves the request on the queue for review', async () => {
    setApprovalHandler(async () => ({ approved: true, remember: false }))
    beginDeferralMode(THREAD)

    await asRun(() => requestApproval(request).catch(() => undefined))

    const pending = await readPendingDeferrals({ threadId: THREAD })
    assert.equal(pending.length, 1)
    assert.equal(pending[0]?.cause, 'shell-sandbox-escalation')
    assert.equal(pending[0].title, 'Run outside sandbox?')
  })

  it('collapses a repeated ask onto the one queue entry', async () => {
    setApprovalHandler(async () => ({ approved: true, remember: false }))
    beginDeferralMode(THREAD)

    await asRun(() => requestApproval(request).catch(() => undefined))
    await asRun(() => requestApproval(request).catch(() => undefined))

    assert.equal((await readPendingDeferrals({ threadId: THREAD })).length, 1)
  })

  it('prompts as normal once the mode ends', async () => {
    let handlerCalls = 0
    setApprovalHandler(async () => {
      handlerCalls++
      return { approved: true, remember: false }
    })

    beginDeferralMode(THREAD)
    await asRun(() => requestApproval(request).catch(() => undefined))
    endDeferralMode(THREAD)

    const response = await asRun(() => requestApproval(request))
    assert.equal(response.approved, true)
    assert.equal(handlerCalls, 1)
  })

  it('leaves other threads interactive', async () => {
    let handlerCalls = 0
    setApprovalHandler(async () => {
      handlerCalls++
      return { approved: true, remember: false }
    })
    beginDeferralMode('some-other-thread')

    const response = await asRun(() => requestApproval(request))
    assert.equal(response.approved, true)
    assert.equal(handlerCalls, 1)
    assert.equal((await readPendingDeferrals({ threadId: THREAD })).length, 0)
  })
})
