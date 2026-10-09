import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import type { ThreadChangeSummary } from '@shared/types/git.ts'
import { createThreadChangeSummaryReader } from './thread-change-summary.ts'

interface Harness {
  summarize: ReturnType<typeof createThreadChangeSummaryReader>
  reads: string[]
  peak: () => number
}

function harness(
  roots: Record<string, string>,
  opts: { ttlMs?: number; clock?: () => number } = {},
): Harness {
  const reads: string[] = []
  let active = 0
  let peak = 0
  const summarize = createThreadChangeSummaryReader({
    resolveRoot: async (_projectId, threadId) => {
      const root = roots[threadId]
      if (root === undefined) throw new Error('unknown thread')
      return root
    },
    read: async (root): Promise<ThreadChangeSummary | null> => {
      reads.push(root)
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      if (root === '/not-a-repo') return null
      if (root === '/boom') throw new Error('git exploded')
      return { dirty: root === '/dirty' }
    },
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
    ...(opts.clock ? { now: opts.clock } : {}),
    concurrency: 2,
  })
  return { summarize, reads, peak: (): number => peak }
}

const ref = (threadId: string): { projectId: string; threadId: string } => ({
  projectId: 'p',
  threadId,
})

describe('git:thread-change-summary handler', () => {
  it('resolves roots without restoring worktrees or arming a watcher', async () => {
    const source = await readFile(
      new URL('../../ipc/register-handlers.ts', import.meta.url),
      'utf8',
    )
    const start = source.indexOf('createThreadChangeSummaryReader({')
    const end = source.indexOf("ipcMain.handle('git:change-stats'")
    assert.ok(start !== -1 && end > start, 'handler block not found')
    const block = source.slice(start, end)
    assert.match(block, /resolveRoot: inspectThreadCheckoutRoot/)
    assert.doesNotMatch(
      block,
      /ensureWorkingTreeWatched|resolveThreadExecutionContext|resolveWatchedGitRoot/,
    )
  })
})

describe('createThreadChangeSummaryReader', () => {
  it('reads a shared checkout once for N threads', async () => {
    const { summarize, reads } = harness({ a: '/shared', b: '/shared', c: '/shared', d: '/shared' })
    const out = await summarize(['a', 'b', 'c', 'd'].map(ref))
    assert.deepEqual(reads, ['/shared'])
    assert.equal(out.length, 4)
    assert.ok(out.every((entry) => entry?.dirty === false))
  })

  it('reads each worktree thread from its own root, aligned with the input order', async () => {
    const { summarize, reads } = harness({ a: '/dirty', b: '/clean', c: '/dirty' })
    const out = await summarize(['a', 'b', 'c'].map(ref))
    assert.deepEqual(reads.toSorted(), ['/clean', '/dirty'])
    assert.deepEqual(out, [{ dirty: true }, { dirty: false }, { dirty: true }])
  })

  it('returns null for a non-repo, a failing read, and an unresolvable thread', async () => {
    const { summarize } = harness({ a: '/not-a-repo', b: '/boom' })
    assert.deepEqual(await summarize(['a', 'b', 'missing'].map(ref)), [null, null, null])
  })

  it('shares one in-flight read and caches within the TTL, then rereads', async () => {
    let t = 0
    const { summarize, reads } = harness({ a: '/r', b: '/r' }, { ttlMs: 1_000, clock: () => t })
    await Promise.all([summarize([ref('a')]), summarize([ref('b')])])
    assert.deepEqual(reads, ['/r'])
    t = 500
    await summarize([ref('a')])
    assert.deepEqual(reads, ['/r'])
    t = 1_500
    await summarize([ref('a')])
    assert.deepEqual(reads, ['/r', '/r'])
  })

  it('shares a slow in-flight read after the TTL and for fresh requests', async () => {
    let clock = 0
    let reads = 0
    let finish: (value: ThreadChangeSummary) => void = () => {}
    const result = new Promise<ThreadChangeSummary>((resolve) => {
      finish = resolve
    })
    const summarize = createThreadChangeSummaryReader({
      resolveRoot: async () => '/slow',
      read: async () => {
        reads++
        return result
      },
      now: () => clock,
      ttlMs: 100,
    })
    const first = summarize([ref('a')])
    await new Promise((resolve) => setTimeout(resolve, 0))
    clock = 200
    const second = summarize([ref('b')], { fresh: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(reads, 1)
    finish({ dirty: true })
    assert.deepEqual(await first, [{ dirty: true }])
    assert.deepEqual(await second, [{ dirty: true }])
    clock = 250
    await summarize([ref('a')])
    assert.equal(reads, 1, 'TTL starts when the read completes')
  })

  it('limits concurrent Git reads across separate IPC requests', async () => {
    const { summarize, peak } = harness({ a: '/a', b: '/b', c: '/c', d: '/d' })
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => summarize([ref(id)])))
    assert.equal(peak(), 2)
  })

  it('lets a fresh request bypass the cache', async () => {
    const { summarize, reads } = harness({ a: '/r' }, { ttlMs: 60_000 })
    await summarize([ref('a')])
    await summarize([ref('a')])
    assert.deepEqual(reads, ['/r'])
    await summarize([ref('a')], { fresh: true })
    assert.deepEqual(reads, ['/r', '/r'])
  })

  it('treats a thread with no inspectable checkout as null without reading', async () => {
    const reads: string[] = []
    const summarize = createThreadChangeSummaryReader({
      resolveRoot: async () => null,
      read: async (root) => {
        reads.push(root)
        return { dirty: false }
      },
    })
    assert.deepEqual(await summarize([ref('retired')]), [null])
    assert.deepEqual(reads, [])
  })

  it('limits distinct-root concurrency', async () => {
    const { summarize, peak } = harness({ a: '/1', b: '/2', c: '/3', d: '/4', e: '/5' })
    await summarize(['a', 'b', 'c', 'd', 'e'].map(ref))
    assert.ok(peak() <= 2, `peak concurrency ${String(peak())}`)
  })
})
