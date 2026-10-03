// The new-thread screen host: placement before the composer, unique ids beside
// the overlay, drawing only while shown, and leaving focus with the composer.
import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore, type AppStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import { createPendingApi } from '../fake-api.test-support.ts'
import { mountActivityHome } from './activity-home.ts'
import { mountActivityPanel } from './activity-panel.ts'
import type { ApprovalRequests } from './approval-dialog.ts'
import type { AskUserRequests } from './ask-user-dialog.ts'

const noApprovals: ApprovalRequests = {
  pending: () => [],
  answerOnce: () => false,
  onChange: () => () => {},
}
const noQuestions: AskUserRequests = { pending: () => [], onChange: () => () => {} }

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

interface Mounted {
  store: AppStore
  pane: HTMLElement
  composer: HTMLElement
  home: ReturnType<typeof mountActivityHome>
  flush: () => void
}

function mount(threads: Thread[]): Mounted {
  const pane = document.createElement('main')
  pane.id = 'pane-chat'
  const input = document.createElement('div')
  input.id = 'input-bar'
  const composer = document.createElement('textarea')
  composer.className = 'prompt-input'
  input.append(composer)
  pane.append(input)
  document.body.append(pane)

  const store = createStore({
    projects: [{ id: 'p1', path: '/work', name: 'workspace' }],
    activeProjectId: 'p1',
    expandedProjectId: 'p1',
    workspaceRoot: '/work',
    threads,
    activeThreadId: threads[0]?.id ?? null,
  })
  // Queued, never self-running: a view that re-arms its age tick would loop.
  const queued: Array<() => void> = []
  const deps = {
    now: (): number => 1_000_000,
    setTimer: (fn: () => void): (() => void) => {
      queued.push(fn)
      return (): void => {}
    },
  }
  const sources = { approvals: noApprovals, questions: noQuestions }
  const api = createPendingApi({})
  const home = mountActivityHome(pane, api, store, sources, deps)
  return {
    store,
    pane,
    composer,
    home,
    flush: (): void => {
      for (const fn of queued.splice(0)) fn()
    },
  }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('activity home', () => {
  it('mounts hidden, before the composer', () => {
    const { pane } = mount([thread('t1', { status: 'running' })])
    const root = pane.querySelector<HTMLElement>('#activity-home')
    assert.ok(root)
    assert.equal(root.hidden, true)
    assert.ok(root.nextElementSibling?.id === 'input-bar', 'the home must sit before #input-bar')
    assert.equal(root.querySelectorAll('.activity-row').length, 0, 'nothing is drawn while hidden')
  })

  it('draws on show without taking focus from the composer', () => {
    const { pane, composer, home } = mount([thread('t1', { status: 'running' })])
    composer.focus()
    home.setShown(true)

    assert.equal(pane.querySelector<HTMLElement>('#activity-home')?.hidden, false)
    assert.equal(pane.querySelectorAll('#activity-home .activity-row').length, 1)
    assert.ok(document.activeElement === composer, 'the composer keeps focus')
  })

  it('stops drawing once hidden', () => {
    const { store, pane, home, flush } = mount([thread('t1', { status: 'running' })])
    home.setShown(true)
    home.setShown(false)
    assert.equal(pane.querySelector<HTMLElement>('#activity-home')?.hidden, true)

    store.setState({ threads: [thread('t1', { status: 'running' }), thread('t2')] })
    store.emit('thread_status_changed', 't2', 'running')
    flush()
    assert.equal(
      pane.querySelectorAll('#activity-home .activity-row').length,
      1,
      'a hidden home must not redraw',
    )
  })

  it('shares no element id with the overlay once both are drawn', () => {
    const opened = function (this: HTMLDialogElement): void {
      this.open = true
    }
    Object.defineProperties(window.HTMLDialogElement.prototype, {
      show: { configurable: true, value: opened },
      showModal: { configurable: true, value: opened },
    })
    const { store, home } = mount([thread('t1', { status: 'running' })])
    const deps = { now: (): number => 1_000_000, setTimer: (): (() => void) => () => {} }
    const panel = mountActivityPanel(
      createPendingApi({}),
      store,
      { approvals: noApprovals, questions: noQuestions },
      deps,
    )
    home.setShown(true)
    panel.open()

    // Rows, a group title and the detail title exist in both hosts now.
    assert.ok(document.querySelector('#activity-home .activity-group-title'))
    assert.ok(document.querySelector('#activity-panel .activity-group-title'))
    const ids = [...document.querySelectorAll('[id]')].map((node) => node.id)
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
    assert.deepEqual(duplicates, [])
  })
})
