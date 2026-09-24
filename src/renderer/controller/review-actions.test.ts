import '../../../tests/setup-dom.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dismissReviewFinding,
  dismissReviewReport,
  restoreReviewFinding,
  retryReview,
  startReview,
} from './review-actions.ts'
import { createStore } from '@shared/store/store.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ReviewFindingRecord, Thread, ThreadReviewReport } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { takeQuietRun } from './quiet-runs.ts'
import { getReviewReportTarget } from './review-report-target.ts'

function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const finding: ReviewFindingRecord = {
  id: '0123456789abcdef',
  path: 'src/math.ts',
  startLine: 3,
  claim: 'add subtracts its second argument.',
  class: 'contract',
  severity: 'high',
  confidence: 'high',
  verdict: { status: 'confirmed', reason: 'The reproducer fails on head and passes on base.' },
  raisedBy: ['gpt-5 (correctness)'],
  corroboratedBy: [],
  challengedBy: [],
  evidence: [],
}

function report(overrides: Partial<ThreadReviewReport> = {}): ThreadReviewReport {
  return {
    status: 'done',
    startedAt: 1,
    models: { reviewer: 'gpt-5', challenger: 'claude-opus-4-8' },
    lenses: ['correctness'],
    baseRef: 'HEAD',
    headCommit: 'abc',
    dirtyWorkingTree: true,
    execution: { backend: 'os-sandbox', strength: 'os-sandbox', executed: true, reason: '' },
    checks: [],
    notChecked: [],
    findings: [finding],
    appendix: 0,
    refuted: 0,
    reviewers: [],
    verification: null,
    durationMs: 10,
    ...overrides,
  }
}

interface Calls {
  review: unknown[][]
  runs: unknown[][]
  dismissed: unknown[]
  restored: unknown[]
}

function setup(
  activeProjectId: string | null,
  overrides: Partial<Thread> = {},
  behaviour: { dismissFails?: boolean; startFails?: boolean } = {},
): { store: AppStore; api: ApiClient; calls: Calls } {
  const store = createStore({
    activeProjectId,
    activeThreadId: 't1',
    threads: [thread('t1', overrides)],
  })
  const calls: Calls = { review: [], runs: [], dismissed: [], restored: [] }
  const api = ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      agent: {
        ...base['agent'],
        retryReview: (...args: unknown[]): Promise<void> => {
          calls.review.push(args)
          return Promise.resolve()
        },
      },
      review: {
        run: (...args: unknown[]): Promise<void> => {
          calls.runs.push(args)
          return behaviour.startFails
            ? Promise.reject(new Error('Model resolution failed'))
            : Promise.resolve()
        },
        dismissFinding: (input: unknown): Promise<void> => {
          calls.dismissed.push(input)
          return behaviour.dismissFails ? Promise.reject(new Error('disk full')) : Promise.resolve()
        },
        restoreFinding: (id: unknown): Promise<void> => {
          calls.restored.push(id)
          return Promise.resolve()
        },
      },
    } satisfies ApiClient
  })()
  return { store, api, calls }
}

function threadState(store: AppStore): Thread {
  const found = store.getState().threads.find((t) => t.id === 't1')
  assert.ok(found)
  return found
}

// The main-process handlers resolve a ThreadExecutionContext from projectId +
// threadId; without it the reviewer has no checkout. The renderer must
// therefore send the active projectId first, matching `agent:run`.
test('retryReview sends the active projectId ahead of the threadId', () => {
  const { store, api, calls } = setup('project-1')
  retryReview(store, api, 't1', 'm1')
  assert.equal(calls.review.length, 1)
  const [call] = calls.review
  assert.ok(call)
  assert.equal(call[0], 'project-1')
  assert.equal(call[1], 't1')
})

test('startReview seeds a running card, marks the thread running and quiet, then asks main', () => {
  const { store, api, calls } = setup('project-1', { model: 'gpt-5' })
  startReview(store, api, 't1')
  const state = threadState(store)
  assert.equal(state.status, 'running')
  assert.ok(state.reviewReport)
  assert.equal(state.reviewReport.status, 'running')
  assert.equal(state.reviewReport.models.reviewer, 'gpt-5')
  assert.equal(takeQuietRun('t1'), true, 'a review the user clicked for must not chime')
  assert.equal(calls.runs.length, 1)
  const [call] = calls.runs
  assert.ok(call)
  assert.equal(call[0], 'project-1')
  assert.equal(call[1], 't1')
  assert.deepEqual(JSON.parse(String(call[2])), { model: 'gpt-5' })
})

test('startReview does nothing while the thread is already running', () => {
  const { store, api, calls } = setup('project-1', { status: 'running' })
  startReview(store, api, 't1')
  assert.equal(calls.runs.length, 0)
  assert.equal(threadState(store).reviewReport, undefined)
})

test('a new review stays on its assistant turn instead of replacing an earlier report', () => {
  const earlier = report({ startedAt: 1, note: 'Earlier review' })
  const { store, api } = setup('project-1', {
    messages: [
      {
        id: 'm1',
        role: 'assistant',
        content: 'First turn',
        toolCalls: [],
        createdAt: 1,
        reviewReport: earlier,
      },
      { id: 'm2', role: 'assistant', content: 'Second turn', toolCalls: [], createdAt: 2 },
    ],
  })
  startReview(store, api, 't1')
  const current = threadState(store)
  assert.equal(current.messages[0]?.reviewReport, earlier)
  assert.equal(current.messages[1]?.reviewReport?.status, 'running')
  assert.equal(current.reviewReport, undefined)

  dismissReviewReport(store, 't1', 'm1')
  assert.equal(threadState(store).messages[0]?.reviewReport, undefined)
  assert.equal(threadState(store).messages[1]?.reviewReport?.status, 'running')
  takeQuietRun('t1')
})

test('a rejected startup restores idle state and permits retry', async () => {
  const { store, api, calls } = setup('project-1', {}, { startFails: true })
  startReview(store, api, 't1')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(threadState(store).status, 'idle')
  assert.equal(threadState(store).reviewReport?.status, 'error')
  assert.equal(threadState(store).reviewReport?.error, 'Model resolution failed')
  assert.equal(takeQuietRun('t1'), false)
  assert.equal(getReviewReportTarget(store, 't1'), undefined)
  startReview(store, api, 't1')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.runs.length, 2)
})

test('review actions no-op when no project is active rather than send an unresolvable request', () => {
  const { store, api, calls } = setup(null)
  retryReview(store, api, 't1', 'm1')
  startReview(store, api, 't1')
  assert.equal(calls.review.length, 0)
  assert.equal(calls.runs.length, 0)
})

test('dismissing a finding hides it at once and persists it by content id', () => {
  const { store, api, calls } = setup('project-1', { reviewReport: report() })
  dismissReviewFinding(store, api, 't1', finding)
  assert.equal(threadState(store).reviewReport?.findings[0]?.dismissed, true)
  assert.deepEqual(calls.dismissed, [
    {
      findingId: finding.id,
      path: finding.path,
      claim: finding.claim,
      class: finding.class,
    },
  ])
})

test('a dismissal that fails to persist is reverted on the card', async () => {
  const { store, api } = setup('project-1', { reviewReport: report() }, { dismissFails: true })
  dismissReviewFinding(store, api, 't1', finding)
  assert.equal(threadState(store).reviewReport?.findings[0]?.dismissed, true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(threadState(store).reviewReport?.findings[0]?.dismissed, false)
})

test('restoring a finding shows it again and drops the persisted note', () => {
  const { store, api, calls } = setup('project-1', {
    reviewReport: report({ findings: [{ ...finding, dismissed: true }] }),
  })
  restoreReviewFinding(store, api, 't1', finding.id)
  assert.equal(threadState(store).reviewReport?.findings[0]?.dismissed, false)
  assert.deepEqual(calls.restored, [finding.id])
})

test('finding dismissal and restoration update the report on its message', () => {
  const { store, api, calls } = setup('project-1', {
    messages: [
      {
        id: 'm1',
        role: 'assistant',
        content: 'Reviewed turn',
        toolCalls: [],
        createdAt: 1,
        reviewReport: report(),
      },
    ],
  })

  dismissReviewFinding(store, api, 't1', finding, 'm1')
  assert.equal(threadState(store).messages[0]?.reviewReport?.findings[0]?.dismissed, true)
  assert.equal(threadState(store).reviewReport, undefined)

  restoreReviewFinding(store, api, 't1', finding.id, 'm1')
  assert.equal(threadState(store).messages[0]?.reviewReport?.findings[0]?.dismissed, false)
  assert.deepEqual(calls.restored, [finding.id])
})

test('a failed message finding dismissal is reverted on that message', async () => {
  const { store, api } = setup(
    'project-1',
    {
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'Reviewed turn',
          toolCalls: [],
          createdAt: 1,
          reviewReport: report(),
        },
      ],
    },
    { dismissFails: true },
  )

  dismissReviewFinding(store, api, 't1', finding, 'm1')
  assert.equal(threadState(store).messages[0]?.reviewReport?.findings[0]?.dismissed, true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(threadState(store).messages[0]?.reviewReport?.findings[0]?.dismissed, false)
})
