import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMMessage, Message, Thread } from '@shared/types'
import { recordUserReview, USER_REVIEW_PROMPT, type ReviewHistoryDeps } from './review-history.ts'
import { runningReviewReport, type ReviewRunResult } from './review-service.ts'

const THREAD = 'thread-1'
const SUMMARY = '1 finding: src/a.ts:3 drops the error from the retry path.'

function settled(status: 'done' | 'error', summary = SUMMARY): ReviewRunResult {
  const report = runningReviewReport({ reviewer: 'model-a', challenger: 'model-b' }, [], 1_000)
  return { report: { ...report, status }, summary }
}

function deps(
  history: LLMMessage[],
  messages: Message[],
): { deps: ReviewHistoryDeps; saved: LLMMessage[][]; forgotten: string[] } {
  const saved: LLMMessage[][] = []
  const forgotten: string[] = []
  const thread: Thread = {
    id: THREAD,
    title: 'T',
    status: 'idle',
    messages,
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
  return {
    saved,
    forgotten,
    deps: {
      loadHistory: (): Promise<LLMMessage[]> => Promise.resolve(history),
      saveHistory: (_p, _t, next): Promise<void> => {
        saved.push(next)
        return Promise.resolve()
      },
      loadThread: (): Promise<Thread | null> => Promise.resolve(thread),
      forgetHistory: (_p, threadId): void => {
        forgotten.push(threadId)
      },
    },
  }
}

describe('recordUserReview', () => {
  it('appends the report to a history the dispatcher wrote and drops its cache', async () => {
    const earlier: LLMMessage[] = [
      { role: 'user', content: 'fix the retry' },
      { role: 'assistant', content: 'done' },
    ]
    const d = deps(earlier, [])
    const history = await recordUserReview('p', THREAD, settled('done'), d.deps)
    assert.deepEqual(history, [
      ...earlier,
      { role: 'user', content: USER_REVIEW_PROMPT },
      { role: 'assistant', content: `Copse Reviewer report:\n\n${SUMMARY}` },
    ])
    assert.deepEqual(d.saved, [history])
    assert.deepEqual(d.forgotten, [THREAD])
  })

  it('rebuilds from the transcript when there is no sidecar', async () => {
    const transcript: Message[] = [
      { id: 'u1', role: 'user', content: 'fix the retry', toolCalls: [], createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'done', toolCalls: [], createdAt: 2 },
    ]
    const d = deps([], transcript)
    const history = await recordUserReview('p', THREAD, settled('done'), d.deps)
    assert.ok(history)
    assert.deepEqual(
      history.map((m) => m.role),
      ['user', 'assistant', 'user', 'assistant'],
    )
    assert.deepEqual(history[0], { role: 'user', content: 'fix the retry' })
  })

  it('records nothing for an error card or an empty summary', async () => {
    const d = deps([], [])
    assert.equal(await recordUserReview('p', THREAD, settled('error'), d.deps), null)
    assert.equal(await recordUserReview('p', THREAD, settled('done', '  '), d.deps), null)
    assert.deepEqual(d.saved, [])
    assert.deepEqual(d.forgotten, [])
  })

  it('never throws: a history that cannot be read is logged, not fatal', async () => {
    const d = deps([], [])
    d.deps.loadHistory = (): Promise<LLMMessage[]> => Promise.reject(new Error('disk'))
    assert.equal(await recordUserReview('p', THREAD, settled('done'), d.deps), null)
    assert.deepEqual(d.saved, [])
  })
})
