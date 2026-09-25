// The projects sidebar has a per-project thread filter: a search toggle in the
// header reveals an input that narrows the expanded project's thread list by
// title, then by human requests in saved transcripts. Pagination is suppressed,
// with a "No matching threads" note only after the scan finishes. This is the local sibling to the Cmd/Ctrl+Shift+K
// command palette, which jumps across every project at once.
import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createStore } from '@shared/store/store.ts'
import type { Message, Thread } from '@shared/types'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountProjectsPane } from './projects-pane.ts'

function thread(id: string, title: string): Thread {
  return {
    id,
    title,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

// mountProjectsPane refreshes orphan stores on mount (#997), so it needs a real
// ApiClient shape. Built on the browser demo's implementation rather than an
// `as unknown as ApiClient` cast, so this stays type-safe and adds nothing to
// the lint-suppression baseline.
const apiStub = createFakeApi()

/** Query helper: asserts presence instead of asserting the type. */
function must(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector)
  assert.ok(found, `expected to find ${selector}`)
  return found
}

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
})

describe('projects pane thread filter (component)', () => {
  function mount(
    threads: Thread[] = [
      thread('a', 'Fix login bug'),
      thread('b', 'Refactor sidebar'),
      thread('c', 'Login rate limiting'),
    ],
    api = apiStub,
  ): ReturnType<typeof createStore> {
    const store = createStore({
      projects: [{ id: 'p1', path: '/proj', name: 'Proj' }],
      activeProjectId: 'p1',
      expandedProjectId: 'p1',
      workspaceRoot: '/proj',
      threads,
      activeThreadId: 'a',
    })
    const host = document.createElement('div')
    document.body.append(host)
    dispose = mountProjectsPane(host, store, api)
    return store
  }

  function titles(): string[] {
    return [...document.querySelectorAll('.chat-title')].map((n) => n.textContent)
  }

  function setFilter(value: string): void {
    const input = document.querySelector<HTMLInputElement>('.projects-search-input')
    assert.ok(input, 'expected the thread-filter input')
    input.value = value
    input.dispatchEvent(new Event('input'))
  }

  it('hides the filter row until the search toggle is clicked', () => {
    mount()
    const row = must('.projects-search-row')
    assert.equal(row.hidden, true)
    must('.projects-search-btn').click()
    assert.equal(row.hidden, false)
  })

  it('narrows the thread list to title matches', () => {
    mount()
    must('.projects-search-btn').click()
    assert.deepEqual(titles(), ['Fix login bug', 'Refactor sidebar', 'Login rate limiting'])
    setFilter('login')
    assert.deepEqual(titles(), ['Fix login bug', 'Login rate limiting'])
  })

  it('shows a no-matches note only after searching user requests', async () => {
    mount()
    must('.projects-search-btn').click()
    setFilter('zzz-nothing')
    assert.equal(must('.thread-filter-status').textContent, 'Searching user requests…')
    await delay(250)
    assert.deepEqual(titles(), [])
    const empty = document.querySelector('.chats-list .sidebar-empty')
    assert.equal(empty?.textContent, 'No matching threads')
  })

  it('keeps scan progress during streaming and shows newly submitted requests immediately', async () => {
    const api = createFakeApi()
    let finishRead = (_messages: Message[]): void => {
      throw new Error('Read not started')
    }
    const waiting = new Promise<Message[]>((resolve) => {
      finishRead = resolve
    })
    const reads: string[] = []
    api.threads.loadMessages = async (_project, id): Promise<Message[]> => {
      reads.push(id)
      return id === 'old'
        ? waiting
        : [{ id: 'stored', role: 'user', content: 'needle', toolCalls: [], createdAt: 3 }]
    }
    const store = mount(
      [
        { ...thread('old', 'Older work'), messagesLoaded: false },
        { ...thread('new', 'Stored match'), createdAt: 3, messagesLoaded: false },
        { ...thread('live', 'Live request'), createdAt: 2 },
      ],
      api,
    )
    must('.projects-search-btn').click()
    setFilter('needle')
    await delay(250)
    assert.deepEqual(reads, ['new', 'old'])
    assert.deepEqual(titles(), ['Stored match'])
    store.setState({
      threads: store.getState().threads.map((t) =>
        t.id === 'live'
          ? {
              ...t,
              messages: [
                {
                  id: 'live-prompt',
                  role: 'user',
                  content: 'needle',
                  toolCalls: [],
                  createdAt: 2,
                },
              ],
            }
          : { ...t, updatedAt: 99 },
      ),
    })
    store.emit('threads_changed')
    assert.deepEqual(titles(), ['Stored match', 'Live request'])
    await delay(250)
    assert.deepEqual(reads, ['new', 'old'])
    finishRead([])
    await delay(0)
    assert.equal(document.querySelector('.thread-filter-status'), null)
  })

  it('clicking the toggle again clears and hides the filter', () => {
    mount()
    const toggle = must('.projects-search-btn')
    toggle.click()
    setFilter('login')
    assert.equal(titles().length, 2)
    toggle.click() // second click closes + clears
    const row = must('.projects-search-row')
    assert.equal(row.hidden, true)
    assert.equal(titles().length, 3)
  })
})
