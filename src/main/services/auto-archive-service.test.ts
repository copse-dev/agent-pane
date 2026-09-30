import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Thread } from '@shared/types'
import type { ThreadWorktree } from '@shared/types/worktree.ts'
import { DAY_MS } from '@shared/store/auto-archive.ts'
import {
  inspectThreadWorktree,
  runAutoArchiveSweep,
  snapshotFromDetails,
  type AutoArchiveDeps,
  type PrSnapshot,
} from './auto-archive-service.ts'

const NOW = 100 * DAY_MS
const REF = { owner: 'o', repo: 'r', number: 1, url: 'https://github.com/o/r/pull/1' }

function worktree(path: string): ThreadWorktree {
  return {
    path,
    branch: 'b',
    baseBranch: 'main',
    baseCommit: 'abc',
    createdAt: NOW - 30 * DAY_MS,
    seededFromDirtyProject: false,
  }
}

function thread(overrides: Partial<Thread> = {}): Thread {
  const base: Thread = {
    id: 't1',
    title: 'Thread',
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: NOW - 30 * DAY_MS,
    updatedAt: NOW - 10 * DAY_MS,
    prRefs: [REF],
    worktree: worktree('/wt/t1'),
  }
  return { ...base, ...overrides }
}

function sharedThread(id: string): Thread {
  const { worktree: _removed, ...rest } = thread({ id })
  return rest
}

function harness(
  threads: Thread[],
  overrides: Partial<AutoArchiveDeps> = {},
): { deps: AutoArchiveDeps; archived: string[]; prLookups: number[] } {
  const archived: string[] = []
  const prLookups: number[] = []
  const deps: AutoArchiveDeps = {
    afterDays: () => 7,
    projects: () => [{ id: 'p1', path: '/repo' }],
    loadThreads: async () => threads,
    runningThreadIds: () => new Set(),
    stagedDiffCount: () => 0,
    prSnapshot: async (ref): Promise<PrSnapshot> => {
      prLookups.push(ref.number)
      return { state: 'merged', updatedAt: NOW - 9 * DAY_MS }
    },
    worktreeFacts: async () => ({ changedFiles: 0, unpushedCommits: 0 }),
    archive: async (_p, id) => {
      archived.push(id)
    },
    now: () => NOW,
    ...overrides,
  }
  return { deps, archived, prLookups }
}

describe('runAutoArchiveSweep', () => {
  it('archives a merged, clean, idle thread and reports it by project', async () => {
    const { deps, archived } = harness([thread()])
    const result = await runAutoArchiveSweep(deps)
    assert.deepEqual(archived, ['t1'])
    assert.deepEqual(result.archived, [{ projectId: 'p1', threadIds: ['t1'] }])
  })

  it('does nothing when the setting is off', async () => {
    const { deps, archived, prLookups } = harness([thread()], { afterDays: () => 0 })
    await runAutoArchiveSweep(deps)
    assert.deepEqual(archived, [])
    assert.deepEqual(prLookups, [])
  })

  it('restarts the clock from the PR update when it is newer than the thread', async () => {
    const { deps, archived } = harness([thread()], {
      prSnapshot: async () => ({ state: 'merged', updatedAt: NOW - 2 * DAY_MS }),
    })
    await runAutoArchiveSweep(deps)
    assert.deepEqual(archived, [])
  })

  it('never asks GitHub about a thread the local screen already rules out', async () => {
    const { deps, prLookups } = harness([
      thread({ id: 'recent', updatedAt: NOW - DAY_MS }),
      thread({ id: 'running', status: 'running' }),
      thread({ id: 'unread', unreadAt: NOW - DAY_MS }),
      sharedThread('shared'),
      thread({ id: 'nopr', prRefs: [] }),
      thread({ id: 'done', archivedAt: 1 }),
    ])
    await runAutoArchiveSweep(deps)
    assert.deepEqual(prLookups, [])
  })

  it('skips threads the running set names, and open PRs without touching git', async () => {
    let gitCalls = 0
    const { deps, archived } = harness([thread({ id: 'a' }), thread({ id: 'b' })], {
      runningThreadIds: () => new Set(['a']),
      prSnapshot: async () => ({ state: 'open', updatedAt: null }),
      worktreeFacts: async () => {
        gitCalls += 1
        return { changedFiles: 0, unpushedCommits: 0 }
      },
    })
    await runAutoArchiveSweep(deps)
    assert.deepEqual(archived, [])
    assert.equal(gitCalls, 0)
  })

  it('leaves a thread with pending proposed diffs or a dirty checkout', async () => {
    const staged = harness([thread()], { stagedDiffCount: () => 1 })
    await runAutoArchiveSweep(staged.deps)
    assert.deepEqual(staged.archived, [])
    const dirty = harness([thread()], {
      worktreeFacts: async () => ({ changedFiles: 3, unpushedCommits: 0 }),
    })
    await runAutoArchiveSweep(dirty.deps)
    assert.deepEqual(dirty.archived, [])
  })

  it('treats a failed PR lookup as unknown and archives nothing', async () => {
    const { deps, archived } = harness([thread()], {
      prSnapshot: async () => {
        throw new Error('offline')
      },
    })
    await runAutoArchiveSweep(deps)
    assert.deepEqual(archived, [])
  })

  it('looks each PR up once even when several threads share it', async () => {
    const { deps, prLookups } = harness([thread({ id: 'a' }), thread({ id: 'b' })])
    await runAutoArchiveSweep(deps)
    assert.deepEqual(prLookups, [1])
  })

  it('skips SSH projects', async () => {
    const { deps, archived } = harness([thread()], {
      projects: () => [{ id: 'p1', path: '/repo', sshHost: 'box' }],
    })
    await runAutoArchiveSweep(deps)
    assert.deepEqual(archived, [])
  })
})

describe('snapshotFromDetails', () => {
  it('maps GitHub details and tolerates missing data', () => {
    assert.deepEqual(snapshotFromDetails({ state: 'MERGED', updatedAt: '2026-01-01T00:00:00Z' }), {
      state: 'merged',
      updatedAt: Date.parse('2026-01-01T00:00:00Z'),
    })
    assert.deepEqual(snapshotFromDetails(null), { state: 'unknown', updatedAt: null })
    assert.equal(snapshotFromDetails({ state: 'OPEN' }).updatedAt, null)
  })
})

describe('inspectThreadWorktree', () => {
  it('reports an already-removed checkout as holding nothing', async () => {
    const facts = await inspectThreadWorktree(
      thread({ worktree: worktree('/definitely/not/here') }),
      async () => {
        throw new Error('git must not run')
      },
    )
    assert.deepEqual(facts, { changedFiles: 0, unpushedCommits: 0 })
  })

  it('counts changed paths and unpushed commits from git', async () => {
    const facts = await inspectThreadWorktree(
      thread({ worktree: worktree(process.cwd()) }),
      async (_cwd, args) =>
        args[0] === 'status'
          ? { stdout: ' M a.ts\0?? b.ts\0', code: 0 }
          : { stdout: '2\n', code: 0 },
    )
    assert.deepEqual(facts, { changedFiles: 2, unpushedCommits: 2 })
  })

  it('reports unknown when git fails', async () => {
    const facts = await inspectThreadWorktree(
      thread({ worktree: worktree(process.cwd()) }),
      async () => ({ stdout: '', code: 128 }),
    )
    assert.deepEqual(facts, { changedFiles: null, unpushedCommits: null })
  })
})
