import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Thread } from '@shared/types'
import { COPSE_PRODUCT_REPO_URL } from './product-repo.ts'
import { buildShareTraceIssueUrl } from './share-trace-issue.ts'

function sampleThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-abc',
    title: 'Footer overflow / share',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messages: [{ id: 'm1', role: 'user', createdAt: 1, content: 'hello', toolCalls: [] }],
    usage: { inputTokens: 1, outputTokens: 2 },
    model: 'claude-sonnet-4',
    ...overrides,
  }
}

describe('buildShareTraceIssueUrl', () => {
  it('opens a prefilled new-issue form on the product repo', () => {
    const url = new URL(buildShareTraceIssueUrl(sampleThread()))
    assert.equal(url.origin + url.pathname, `${COPSE_PRODUCT_REPO_URL}/issues/new`)
    assert.equal(url.searchParams.get('title'), 'Debug trace: Footer overflow / share')
    const body = url.searchParams.get('body') ?? ''
    assert.match(body, /thread-abc/)
    assert.match(body, /claude-sonnet-4/)
    assert.match(body, /attach the downloaded/i)
  })

  it('falls back to the thread id when the title is blank', () => {
    const url = new URL(buildShareTraceIssueUrl(sampleThread({ title: '   ' })))
    assert.equal(url.searchParams.get('title'), 'Debug trace: thread-abc')
  })
})
