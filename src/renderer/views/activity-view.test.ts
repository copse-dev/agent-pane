// The Activity view on its own, behind a fake host: it draws only while the host
// says it is shown, reports the needs-you count, hands focus to the host when no
// row can hold it, and forgets everything on hide(). The overlay's behaviour
// around it is covered by activity-panel.test.ts.
import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore, type AppStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import { createPendingApi } from '../fake-api.test-support.ts'
import type { ApprovalRequests } from './approval-dialog.ts'
import type { AskUserRequests } from './ask-user-dialog.ts'
import {
  createActivityView,
  ACTIVITY_AGE_REFRESH_MS as VIEW_AGE_REFRESH_MS,
  type ActivityView,
  type ActivityViewHost,
} from './activity-view.ts'
import {
  ACTIVITY_AGE_REFRESH_MS,
  type ActivityPanelDeps,
  type ActivitySources,
} from './activity-panel.ts'

function thread(id: string, patch: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

const noApprovals: ApprovalRequests = {
  pending: () => [],
  answerOnce: () => false,
  onChange: () => () => {},
}

const noQuestions: AskUserRequests = {
  pending: () => [],
  onChange: () => () => {},
}

interface HostState {
  shown: boolean
  fallbackFocus: number
  needsYou: number[]
}

interface Harness {
  store: AppStore
  view: ActivityView
  state: HostState
  flush: () => void
}

function setup(threads: Thread[]): Harness {
  const store = createStore({
    projects: [{ id: 'p1', path: '/work', name: 'workspace' }],
    activeProjectId: 'p1',
    expandedProjectId: 'p1',
    workspaceRoot: '/work',
    threads,
    activeThreadId: threads[0]?.id ?? null,
  })
  // Timers are queued, never run on their own: a view that re-arms its age tick
  // would otherwise loop forever. flush() runs what is due once.
  const queued: Array<() => void> = []
  const needsYou: number[] = []
  const state: HostState = { shown: false, fallbackFocus: 0, needsYou }
  const host: ActivityViewHost = {
    close: () => {},
    isShown: () => state.shown,
    fallbackFocus: () => {
      state.fallbackFocus += 1
    },
    onNeedsYou: (count) => {
      state.needsYou.push(count)
    },
  }
  // Existing panel callers retain these named type imports after extraction.
  const sources: ActivitySources = { approvals: noApprovals, questions: noQuestions }
  const deps: ActivityPanelDeps = {
    now: () => 1_000_000,
    setTimer: (fn) => {
      queued.push(fn)
      return (): void => {}
    },
  }
  const view = createActivityView(createPendingApi({}), store, sources, deps, host)
  const flush = (): void => {
    for (const fn of queued.splice(0)) fn()
  }
  return { store, view, state, flush }
}

function rowCount(view: { body: HTMLElement }): number {
  return view.body.querySelectorAll('.activity-row').length
}

describe('activity view', () => {
  it('preserves the age refresh constant at the original panel module path', () => {
    assert.equal(ACTIVITY_AGE_REFRESH_MS, VIEW_AGE_REFRESH_MS)
  })
  it('draws nothing for a store change while the host has it hidden', () => {
    const { store, view, state, flush } = setup([thread('t1', { status: 'running' })])
    store.emit('thread_status_changed', 't1', 'running')
    flush()
    assert.equal(rowCount(view), 0)
    assert.deepEqual(state.needsYou, [])
  })

  it('draws on show(), reports the needs-you count and keeps focus with a row', () => {
    const { view, state } = setup([thread('t1', { status: 'running' })])
    state.shown = true
    view.show()
    assert.equal(rowCount(view), 1)
    assert.deepEqual(state.needsYou, [0])
    assert.equal(state.fallbackFocus, 0)
    assert.equal(view.body.querySelector('.activity-row')?.getAttribute('data-state'), 'working')
  })

  it('hands focus to the host when there is no row to hold it', () => {
    const { view, state } = setup([thread('t1')])
    state.shown = true
    view.show()
    assert.equal(rowCount(view), 0)
    assert.equal(state.fallbackFocus, 1)
    assert.ok(view.body.querySelector('.activity-empty'))
  })

  it('redraws on a store change while shown, and stops once hidden', () => {
    const { store, view, state, flush } = setup([thread('t1')])
    state.shown = true
    view.show()
    assert.equal(rowCount(view), 0)

    store.setState({ threads: [thread('t1', { status: 'running' })] })
    store.emit('thread_status_changed', 't1', 'running')
    flush()
    assert.equal(rowCount(view), 1)

    state.shown = false
    view.hide()
    store.setState({ threads: [thread('t1'), thread('t2', { status: 'running' })] })
    store.emit('thread_status_changed', 't2', 'running')
    flush()
    assert.equal(rowCount(view), 1, 'a hidden view must not redraw')
    assert.equal(view.status.textContent, '')
  })

  it('selects the most urgent row afresh on every show()', () => {
    const { view, state } = setup([thread('t1', { status: 'running' })])
    state.shown = true
    view.show()
    const first = view.body.querySelector('.activity-row')?.getAttribute('data-row-key')
    assert.ok(first)
    state.shown = false
    view.hide()
    state.shown = true
    view.show()
    assert.equal(
      view.body.querySelector('.activity-row[data-selected]')?.getAttribute('data-row-key'),
      first,
    )
  })
})
