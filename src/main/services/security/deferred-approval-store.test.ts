import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deferApproval,
  readDeferredApprovals,
  readPendingDeferrals,
  resolveDeferral,
} from './deferred-approval-store.ts'
import type { DeferredApprovalInput } from '@shared/threads/deferred-approval.ts'

// Each case gets its own project id, so entries never leak between tests even
// though they share one store root.
let seq = 0
function freshProject(): string {
  seq++
  return `deferred-store-test-${String(seq)}`
}

const roots: string[] = []

beforeEach(() => {
  // The store resolves its root from COPSE_WORKSPACE_DIR; point it at a scratch
  // dir so a test never touches a real workspace.
  const root = mkdtempSync(join(tmpdir(), 'copse-deferred-'))
  roots.push(root)
  process.env['COPSE_WORKSPACE_DIR'] = root
})

process.on('exit', () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function input(overrides: Partial<DeferredApprovalInput> = {}): DeferredApprovalInput {
  return {
    threadId: 'thread-1',
    kind: 'shell',
    title: 'Run outside sandbox?',
    subject: 'shell command (arguments omitted)',
    cause: 'shell-sandbox-escalation',
    reasons: ['git network operation'],
    scope: 'external',
    ...overrides,
  }
}

describe('deferred approval store', () => {
  it('queues a request as pending and reads it back', async () => {
    const projectId = freshProject()
    const entry = await deferApproval(input(), { projectId })

    assert.equal(entry.status, 'pending')
    assert.equal(entry.threadId, 'thread-1')
    assert.equal(entry.cause, 'shell-sandbox-escalation')

    const pending = await readPendingDeferrals({ projectId })
    assert.deepEqual(
      pending.map((item) => item.id),
      [entry.id],
    )
  })

  it('collapses a repeated request onto one entry', async () => {
    const projectId = freshProject()
    const first = await deferApproval(input(), { projectId })
    const second = await deferApproval(input(), { projectId })

    // An agent that retries a blocked action must not fill the review list.
    assert.equal(second.id, first.id)
    assert.equal((await readPendingDeferrals({ projectId })).length, 1)
  })

  it('keeps genuinely different requests apart', async () => {
    const projectId = freshProject()
    await deferApproval(input(), { projectId })
    await deferApproval(input({ subject: 'other command' }), { projectId })
    assert.equal((await readPendingDeferrals({ projectId })).length, 2)
  })

  it('records a resolution without erasing the original request', async () => {
    const projectId = freshProject()
    const entry = await deferApproval(input(), { projectId })
    const resolved = await resolveDeferral(entry.id, 'approved', { projectId })

    assert.equal(resolved?.status, 'approved')
    assert.equal(typeof resolved.resolvedAt, 'number')
    // Same id, same request detail — the queue is evidence as well as state.
    assert.equal(resolved.id, entry.id)
    assert.equal(resolved.at, entry.at)
    assert.equal((await readPendingDeferrals({ projectId })).length, 0)
    assert.equal((await readDeferredApprovals(projectId)).length, 1)
  })

  it('carries a rejection note for the agent', async () => {
    const projectId = freshProject()
    const entry = await deferApproval(input(), { projectId })
    const resolved = await resolveDeferral(entry.id, 'rejected', {
      projectId,
      note: 'not on this branch',
    })
    assert.equal(resolved?.status, 'rejected')
    assert.equal(resolved.note, 'not on this branch')
  })

  it('refuses to resolve twice, so a stale list cannot flip a verdict', async () => {
    const projectId = freshProject()
    const entry = await deferApproval(input(), { projectId })
    assert.notEqual(await resolveDeferral(entry.id, 'rejected', { projectId }), null)
    assert.equal(await resolveDeferral(entry.id, 'approved', { projectId }), null)

    const all = await readDeferredApprovals(projectId)
    assert.equal(all.length, 1)
    assert.equal(all[0]?.status, 'rejected')
  })

  it('returns null for an unknown id', async () => {
    const projectId = freshProject()
    assert.equal(await resolveDeferral('missing', 'approved', { projectId }), null)
  })

  it('redacts secrets in the stored request', async () => {
    const projectId = freshProject()
    const entry = await deferApproval(
      input({ title: 'Run gh auth login --token ghp_0123456789abcdefghij?' }),
      { projectId },
    )
    assert.doesNotMatch(entry.title, /ghp_0123456789abcdefghij/)
    assert.match(entry.title, /<redacted>/)
  })

  it('narrows the pending view to one thread', async () => {
    const projectId = freshProject()
    await deferApproval(input(), { projectId })
    await deferApproval(input({ threadId: 'thread-2' }), { projectId })

    const scoped = await readPendingDeferrals({ projectId, threadId: 'thread-2' })
    assert.equal(scoped.length, 1)
    assert.equal(scoped[0]?.threadId, 'thread-2')
  })

  it('reads an absent queue as empty rather than throwing', async () => {
    assert.deepEqual(await readPendingDeferrals({ projectId: freshProject() }), [])
  })
})
