import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { setThreadStatus } from '@shared/store/thread-helpers.ts'
import type { Thread } from '@shared/types'
import {
  collectActivityThreads,
  deriveActivity,
  formatAge,
  formatAgeLong,
  RECENT_ROW_LIMIT,
  trackRunTimings,
  truncateText,
  UNTITLED_THREAD,
  type ActivityGroup,
  type ActivityInput,
  type ActivityThread,
  type RunTiming,
} from './activity-model.ts'
import { resetProjectSwitchStateForTest, setThreadCacheForTest } from './projects.ts'
import type { PendingApprovalSummary } from '../views/approval-dialog.ts'

afterEach(() => {
  resetProjectSwitchStateForTest()
})

function info(id: string, patch: Partial<ActivityThread> = {}): ActivityThread {
  return { id, title: id, status: 'idle', projectId: 'p1', projectName: 'alpha', ...patch }
}

function input(patch: Partial<ActivityInput>): ActivityInput {
  return { threads: [], approvals: [], questions: [], runs: new Map(), ...patch }
}

function approval(
  id: string,
  threadId: string | undefined,
  receivedAt: number,
): PendingApprovalSummary {
  return {
    id,
    threadId,
    title: 'Run shell command?',
    body: 'printf done',
    bodyAdvice: undefined,
    type: 'shell',
    receivedAt,
  }
}

function group(groups: ActivityGroup[], id: ActivityGroup['id']): ActivityGroup {
  const found = groups.find((candidate) => candidate.id === id)
  assert.ok(found, `expected group ${id}`)
  return found
}

/**
 * A thread whose transcript throws when touched: any derivation that reads
 * `messages` fails the test instead of silently loading history.
 */
function metadataOnly(id: string, patch: Partial<Thread> = {}): Thread {
  const thread: Thread = {
    id,
    title: id,
    status: 'idle',
    messages: [],
    messagesLoaded: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
  Object.defineProperty(thread, 'messages', {
    get(): never {
      throw new Error(`transcript of ${id} was read`)
    },
  })
  return thread
}

describe('deriveActivity', () => {
  it('orders groups by claim on attention: needs you, working, then recent', () => {
    const runs = new Map<string, RunTiming>([
      ['old-run', { startedAt: 100 }],
      ['new-run', { startedAt: 300 }],
      ['done', { startedAt: 10, endedAt: 50 }],
    ])
    const groups = deriveActivity(
      input({
        threads: [
          info('old-run', { status: 'running' }),
          info('new-run', { status: 'running' }),
          info('done'),
          info('broken', { status: 'error' }),
          info('waiting', { status: 'running' }),
          info('quiet'),
        ],
        approvals: [approval('late', 'waiting', 900), approval('early', 'new-run', 200)],
        questions: [
          { id: 'q', threadId: 'done', questions: ['Which migration order?'], receivedAt: 500 },
        ],
        runs,
      }),
    )
    assert.deepEqual(
      groups.map((g) => g.id),
      ['needs-you', 'working', 'recent'],
    )
    // Longest-waiting request first; a thread that waits is not also "working".
    assert.deepEqual(
      group(groups, 'needs-you').rows.map((row) => row.key),
      ['approval:early', 'question:q', 'approval:late'],
    )
    assert.deepEqual(
      group(groups, 'working').rows.map((row) => row.threadId),
      ['old-run'],
    )
    // Failures outrank clean finishes; an idle thread with no end is not "recent".
    assert.deepEqual(
      group(groups, 'recent').rows.map((row) => [row.threadId, row.state]),
      [['broken', 'failed']],
    )
  })

  it('shows a clean finish only when this session saw it end or it completed unseen', () => {
    const groups = deriveActivity(
      input({
        threads: [info('watched'), info('unseen', { unreadAt: 700 }), info('stale')],
        runs: new Map([['watched', { startedAt: 1, endedAt: 900 }]]),
      }),
    )
    const recent = group(groups, 'recent').rows
    assert.deepEqual(
      recent.map((row) => [row.threadId, row.state, row.since]),
      [
        ['watched', 'finished', 900],
        ['unseen', 'finished', 700],
      ],
    )
  })

  it('orders working runs newest first and puts unknown starts last', () => {
    const groups = deriveActivity(
      input({
        threads: [
          info('unknown', { status: 'running' }),
          info('a', { status: 'running' }),
          info('b', { status: 'running' }),
        ],
        runs: new Map([
          ['a', { startedAt: 10, activity: 'Running shell…' }],
          ['b', { startedAt: 20 }],
        ]),
      }),
    )
    const working = group(groups, 'working').rows
    assert.deepEqual(
      working.map((row) => row.threadId),
      ['b', 'a', 'unknown'],
    )
    assert.equal(working[1]?.want, 'Running shell…')
    assert.equal(working[0]?.want, 'Working…')
    assert.equal(working[2]?.since, null)
  })

  it('caps recent rows but keeps the full count', () => {
    const threads = Array.from({ length: RECENT_ROW_LIMIT + 3 }, (_, i) =>
      info(`t${String(i)}`, { unreadAt: i }),
    )
    const recent = group(deriveActivity(input({ threads })), 'recent')
    assert.equal(recent.rows.length, RECENT_ROW_LIMIT)
    assert.equal(recent.total, RECENT_ROW_LIMIT + 3)
    assert.equal(recent.rows[0]?.threadId, `t${String(RECENT_ROW_LIMIT + 2)}`)
  })

  it('names the request, its thread and project, and never leaves a name blank', () => {
    const groups = deriveActivity(
      input({
        threads: [info('t', { title: '   ', projectName: 'beta' })],
        approvals: [approval('a', 't', 1), approval('orphan', undefined, 2)],
        questions: [
          {
            id: 'q',
            threadId: 'gone',
            questions: ['First?', 'Second?', 'Third?'],
            receivedAt: 3,
          },
        ],
      }),
    )
    const needs = group(groups, 'needs-you').rows
    const a = needs[0]
    const orphan = needs[1]
    const q = needs[2]
    assert.ok(a && orphan && q)
    assert.deepEqual(
      {
        state: a.state,
        want: a.want,
        detail: a.detail,
        requestId: a.requestId,
        threadTitle: a.threadTitle,
        projectName: a.projectName,
      },
      {
        state: 'needs-approval',
        want: 'Run shell command?',
        detail: 'printf done',
        requestId: 'a',
        threadTitle: UNTITLED_THREAD,
        projectName: 'beta',
      },
    )
    assert.equal(orphan.threadTitle, 'No thread')
    assert.equal(orphan.threadId, null)
    // A question from a thread in a project not loaded this session still lists.
    assert.equal(q.state, 'needs-answer')
    assert.equal(q.want, 'First? (+2 more)')
    assert.equal(q.projectId, null)
  })

  it('truncates long wants on a word-agnostic character budget', () => {
    assert.equal(truncateText('a  b\n c'), 'a b c')
    const long = 'x'.repeat(500)
    const cut = truncateText(long, 20)
    assert.equal(cut.length, 20)
    assert.ok(cut.endsWith('…'))
  })
})

describe('collectActivityThreads', () => {
  it('reads metadata from every loaded project without touching a transcript', () => {
    setThreadCacheForTest('p2', [metadataOnly('cached', { title: 'Cached run', unreadAt: 5 })])
    const store = createStore({
      projects: [
        { id: 'p1', path: '/one', name: 'one' },
        { id: 'p2', path: '/two', name: 'two' },
        { id: 'p3', path: '/three', name: 'three' },
      ],
      activeProjectId: 'p1',
      threads: [
        metadataOnly('active', { status: 'running' }),
        metadataOnly('archived', { archivedAt: 3 }),
      ],
      backgroundThreads: [
        { projectId: 'p2', thread: metadataOnly('carried', { status: 'running' }) },
      ],
    })
    const threads = collectActivityThreads(store)
    assert.deepEqual(
      threads.map((t) => [t.id, t.status, t.projectId, t.projectName]),
      [
        ['active', 'running', 'p1', 'one'],
        ['cached', 'idle', 'p2', 'two'],
        ['carried', 'running', 'p2', 'two'],
      ],
    )
    // And the full derivation over them stays metadata-only too.
    const groups = deriveActivity(input({ threads }))
    assert.equal(group(groups, 'working').rows.length, 2)
  })

  it('prefers a carried background run over its stale cached row', () => {
    setThreadCacheForTest('p2', [metadataOnly('t', { status: 'running' })])
    const store = createStore({
      projects: [
        { id: 'p1', path: '/one', name: 'one' },
        { id: 'p2', path: '/two', name: 'two' },
      ],
      activeProjectId: 'p1',
      backgroundThreads: [{ projectId: 'p2', thread: metadataOnly('t', { status: 'error' }) }],
    })
    assert.deepEqual(
      collectActivityThreads(store).map((t) => t.status),
      ['error'],
    )
  })
})

describe('trackRunTimings', () => {
  it('records starts, ends and the latest activity label from store events', () => {
    let clock = 1_000
    const thread: Thread = {
      id: 't',
      title: 't',
      status: 'idle',
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: 1,
    }
    const store = createStore({ threads: [thread] })
    const { runs, dispose } = trackRunTimings(store, () => clock)

    setThreadStatus(store, 't', 'running')
    clock = 2_000
    // A repeated running write is not a new run.
    setThreadStatus(store, 't', 'running')
    store.emit('agent_activity', 't', 'Running shell…')
    assert.deepEqual(runs.get('t'), { startedAt: 1_000, activity: 'Running shell…' })

    clock = 5_000
    setThreadStatus(store, 't', 'idle')
    assert.deepEqual(runs.get('t'), { startedAt: 1_000, endedAt: 5_000, activity: null })

    // An idle write for a thread never seen running invents nothing.
    store.emit('thread_status_changed', 'other', 'idle')
    assert.equal(runs.has('other'), false)
    // An error always ends a run, seen or not.
    store.emit('thread_status_changed', 'other', 'error')
    assert.equal(runs.get('other')?.endedAt, 5_000)

    dispose()
    store.emit('thread_status_changed', 't', 'running')
    assert.equal(runs.get('t')?.startedAt, 1_000)
  })
})

describe('formatAge', () => {
  it('uses compact units and spells them out for assistive tech', () => {
    assert.equal(formatAge(59_000), 'now')
    assert.equal(formatAge(4 * 60_000), '4m')
    assert.equal(formatAge(2 * 3_600_000 + 5), '2h')
    assert.equal(formatAge(3 * 86_400_000), '3d')
    assert.equal(formatAgeLong(10), 'just now')
    assert.equal(formatAgeLong(60_000), '1 minute')
    assert.equal(formatAgeLong(12 * 60_000), '12 minutes')
    assert.equal(formatAgeLong(26 * 3_600_000), '1 day')
  })
})
