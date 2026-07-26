// The projects sidebar has a per-project thread filter: a search toggle in the
// header reveals an input that narrows the expanded project's thread list by
// title, showing every match (pagination suppressed) or a "No matching threads"
// note when none match. This is the local sibling to the Cmd/Ctrl+Shift+K
// command palette, which jumps across every project at once.
import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
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

afterEach(() => {
  document.body.replaceChildren()
})

describe('projects pane thread filter (component)', () => {
  function mount(): void {
    const store = createStore({
      projects: [{ id: 'p1', path: '/proj', name: 'Proj' }],
      activeProjectId: 'p1',
      expandedProjectId: 'p1',
      workspaceRoot: '/proj',
      threads: [
        thread('a', 'Fix login bug'),
        thread('b', 'Refactor sidebar'),
        thread('c', 'Login rate limiting'),
      ],
      activeThreadId: 'a',
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountProjectsPane(host, store, apiStub)
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

  it('shows a no-matches note when nothing matches', () => {
    mount()
    must('.projects-search-btn').click()
    setFilter('zzz-nothing')
    assert.deepEqual(titles(), [])
    const empty = document.querySelector('.chats-list .sidebar-empty')
    assert.equal(empty?.textContent, 'No matching threads')
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
