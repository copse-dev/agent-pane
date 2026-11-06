import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Thread } from '@shared/types/thread.ts'
import type { ProviderStreamChunk } from '@shared/types/stream.ts'
import type { ThreadActionVerdict } from '@shared/threads/action-assessment.ts'
import {
  ThreadActionAssessor,
  threadActionEvidence,
  type ThreadActionDeps,
} from './thread-action-assessment.ts'

function thread(id: string, at = 1): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    createdAt: at,
    updatedAt: at,
    messages: [
      { id: id + '-user', role: 'user', content: 'Explain the code', toolCalls: [], createdAt: at },
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
  }
}

interface Harness {
  deps: ThreadActionDeps
  threads: Thread[]
  prompts: string[]
  calls: () => number
  now: (value: number) => void
  reply: (value: ThreadActionVerdict | null) => void
  assessor: () => ThreadActionAssessor
}

function harness(threads = [thread('a')]): Harness {
  let persisted: unknown
  let calls = 0
  let now = 100
  let reply: ThreadActionVerdict | null = {
    status: 'complete',
    reason: 'Explanation delivered.',
    evidence: [],
  }
  const prompts: string[] = []
  const deps: ThreadActionDeps = {
    now: () => now,
    projects: () => ['p'],
    list: async () => threads,
    get: async (_projectId, id) => threads.find((item) => item.id === id) ?? null,
    read: async (_projectId, id) => threads.find((item) => item.id === id) ?? null,
    load: () => persisted,
    save: (ledger) => {
      persisted = structuredClone(ledger)
    },
    route: async () => ({
      model: 'test',
      provider: {
        async *stream(): AsyncGenerator<ProviderStreamChunk> {
          yield { type: 'done' }
        },
      },
    }),
    judge: async (_route, prompt) => {
      calls++
      prompts.push(prompt)
      return reply
    },
    busy: () => false,
  }
  return {
    deps,
    threads,
    prompts,
    calls: (): number => calls,
    now: (value: number): void => {
      now = value
    },
    reply: (value: ThreadActionVerdict | null): void => {
      reply = value
    },
    assessor: (): ThreadActionAssessor => new ThreadActionAssessor(deps),
  }
}

describe('thread action assessment', () => {
  it('assesses one old thread per tick, including ones without todos or changes', async () => {
    const h = harness([thread('old', 1), thread('middle', 2), thread('new', 3)])
    const assessor = h.assessor()
    await assessor.tick()
    assert.equal(h.calls(), 1)
    assert.equal(assessor.snapshot().entries[0]?.threadId, 'new')
    assert.equal(assessor.snapshot().pending, 2)
    await assessor.tick()
    assert.equal(assessor.snapshot().entries[1]?.threadId, 'old')
    assert.ok(h.prompts[0]?.includes('File changes, unread replies'))
    assert.ok(h.prompts[0]?.includes('Explain the code'))
  })

  it('retains verdicts across restart and metadata changes without another judge call', async () => {
    const h = harness()
    await h.assessor().tick()
    const item = h.threads[0]
    assert.ok(item)
    item.unreadAt = 40
    item.title = 'Renamed'
    item.updatedAt = 60
    const restarted = h.assessor()
    await restarted.tick()
    await restarted.tick()
    assert.equal(h.calls(), 1)
    assert.equal(restarted.snapshot().entries[0]?.assessment.status, 'complete')
  })

  it('reassesses a changed transcript even when run timestamps were restored', async () => {
    const h = harness()
    await h.assessor().tick()
    const item = h.threads[0]
    assert.ok(item)
    item.messages.push({
      id: 'new-message',
      role: 'user',
      content: 'Also fix it',
      toolCalls: [],
      createdAt: 90,
    })
    item.updatedAt = 90
    await h.assessor().tick()
    assert.equal(h.calls(), 2)
  })

  it('persists uncertainty and interrupted attempts without a retry loop', async () => {
    const h = harness()
    h.deps.judge = async (): Promise<ThreadActionVerdict | null> => {
      throw new Error('timeout')
    }
    let attempts = 0
    const judge = h.deps.judge
    h.deps.judge = async (...args): Promise<ThreadActionVerdict | null> => {
      attempts++
      return judge(...args)
    }
    await h.assessor().tick()
    const restarted = h.assessor()
    await restarted.tick()
    assert.equal(attempts, 1)
    assert.equal(restarted.snapshot().entries[0]?.assessment.status, 'uncertain')
  })

  it('rejects action claims without real message evidence', async () => {
    const h = harness()
    h.reply({ status: 'needs-action', reason: 'Must commit.', evidence: ['invented'] })
    const assessor = h.assessor()
    await assessor.tick()
    assert.equal(assessor.snapshot().entries[0]?.assessment.status, 'uncertain')
  })

  it('does not publish an in-flight result for changed evidence', async () => {
    const h = harness()
    const item = h.threads[0]
    assert.ok(item)
    h.deps.judge = async (): Promise<ThreadActionVerdict | null> => {
      item.updatedAt++
      return { status: 'complete', reason: 'Done.', evidence: [] }
    }
    const assessor = h.assessor()
    await assessor.tick()
    assert.equal(assessor.snapshot().entries.length, 0)
  })

  it('skips running threads and prevents overlapping ticks', async () => {
    const h = harness([thread('a'), { ...thread('b'), status: 'running' }])
    const assessor = h.assessor()
    await Promise.all([assessor.tick(), assessor.tick()])
    assert.equal(h.calls(), 1)
    assert.equal(assessor.snapshot().pending, 1)
  })

  it('carries the hourly budget across restart and permits later onboarding progress', async () => {
    const h = harness(Array.from({ length: 34 }, (_, index) => thread(String(index), index)))
    for (let index = 0; index < 32; index++) await h.assessor().tick()
    assert.equal(h.calls(), 30)
    const assessor = h.assessor()
    await assessor.tick()
    assert.equal(assessor.snapshot().budgetLimited, true)
    h.now(3_600_101)
    await assessor.tick()
    assert.equal(h.calls(), 31)
  })

  it('keeps bounded evidence valid JSON and includes the latest user scope', () => {
    const item = thread('a')
    item.messages = Array.from({ length: 100 }, (_, index) => ({
      id: String(index),
      role: 'user',
      content: 'x'.repeat(5000),
      toolCalls: [],
      createdAt: index,
    }))
    const evidence = threadActionEvidence(item)
    const parsed: unknown = JSON.parse(evidence)
    assert.ok(parsed)
    assert.ok(evidence.length <= 15_000)
    assert.ok(evidence.includes('"id":"99"'))
    assert.ok(evidence.includes('"transcriptIncomplete":true'))
  })
})
