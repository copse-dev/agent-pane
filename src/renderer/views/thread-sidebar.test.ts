import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createStore } from '@shared/store/store.ts'
import type { Message, OrphanProjectStore, Thread } from '@shared/types'
import type { GhPrDetails, GitStatusResult } from '@shared/types/git.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountThreadSidebar } from './thread-sidebar.ts'
import type { ActivitySources } from './activity-panel.ts'
import type { PendingQuestionSummary } from './ask-user-dialog.ts'
import { summarizeThreadWork } from '../controller/thread-browser.ts'

globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)

const clean = { staged: [], unstaged: [] }
const dirty = {
  staged: [{ path: 'both.ts', status: 'modified' }],
  unstaged: [
    { path: 'both.ts', status: 'modified' },
    { path: 'new.ts', status: 'untracked' },
  ],
} satisfies Awaited<ReturnType<ReturnType<typeof createFakeApi>['git']['status']>>

/** Each fixture thread owns a worktree, so its Git status is its own. */
function worktree(id: string): NonNullable<Thread['worktree']> {
  return {
    path: `/worktrees/${id}`,
    branch: id,
    baseBranch: 'main',
    baseCommit: 'abc',
    createdAt: 1,
    seededFromDirtyProject: false,
  }
}

function thread(id: string, updatedAt: number, patch: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    worktree: worktree(id),
    ...patch,
  }
}

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
})

function find(selector: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(selector)
  assert.ok(node, selector)
  return node
}

function rows(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.thread-browser-row')].map(
    (row) => row.dataset['threadId'] ?? '',
  )
}

describe('default thread sidebar', () => {
  function mount(workspaceRoot: string | null = '/first'): {
    store: ReturnType<typeof createStore>
    api: ApiClient
    calls: string[]
    changed: () => void
    answer: () => void
  } {
    const api = createFakeApi()
    const calls: string[] = []
    let changed = (): void => {}
    let questionChanged = (): void => {}
    let questions: PendingQuestionSummary[] = [
      { id: 'question', threadId: 'waiting', questions: ['Continue?'], receivedAt: 1 },
    ]
    const sources: ActivitySources = {
      approvals: { pending: () => [], onChange: () => () => {}, answerOnce: () => false },
      questions: {
        pending: () => questions,
        onChange: (listener) => {
          questionChanged = listener
          return () => {}
        },
      },
    }
    const store = createStore({
      projects: [
        { id: 'one', name: 'First', path: '/first' },
        { id: 'two', name: 'Second', path: '/second' },
      ],
      activeProjectId: 'one',
      activeThreadId: 'waiting',
      workspaceRoot,
      threads: [
        thread('waiting', 2),
        thread('working', 3, { status: 'running' }),
        thread('finished', 4, { unreadAt: 4 }),
        thread('unknown', 5),
      ],
    })
    // Saved metadata as main returns it: no transcript read yet.
    api.threads.loadProject = async (): Promise<Thread[]> => [
      thread('other-project', 6, { messagesLoaded: false }),
    ]
    api.git.status = async (_project, id): Promise<GitStatusResult> => {
      calls.push(id)
      if (id === 'unknown') throw new Error('Missing checkout')
      return id === 'finished' || id === 'other-project' ? dirty : clean
    }
    api.git.onWorkingTreeChanged = (listener): (() => void) => {
      changed = (): void => {
        for (const id of ['waiting', 'working', 'finished', 'unknown', 'other-project']) {
          listener(worktree(id).path)
        }
      }
      return (): void => {}
    }
    const root = document.createElement('div')
    document.body.append(root)
    dispose = mountThreadSidebar(root, store, api, sources)
    return {
      store,
      api,
      calls,
      changed: (): void => {
        changed()
      },
      answer: (): void => {
        questions = []
        questionChanged()
      },
    }
  }

  it('opens to Activity, loads unopened projects and tracks focused pending questions', async () => {
    const fixture = mount()
    assert.equal(find('[aria-label="Sort threads"]').getAttribute('aria-label'), 'Sort threads')
    assert.equal(find('[data-group="needs-you"] .chat-title').textContent, 'waiting')
    assert.equal(find('[data-group="working"] .chat-title').textContent, 'working')
    await delay(80)
    assert.ok(rows().includes('other-project'))
    fixture.answer()
    await delay(50)
    assert.equal(document.querySelector('[data-group="needs-you"]'), null)
  })

  it('finds finished dirty threads across projects and intersects search and project filters', async () => {
    mount()
    await delay(80)
    find('.thread-work-filter').click()
    assert.deepEqual(rows(), ['other-project', 'finished'])
    const projects = document.querySelector<HTMLSelectElement>('[aria-label="Filter by project"]')
    assert.ok(projects)
    projects.value = 'one'
    projects.dispatchEvent(new Event('change'))
    assert.deepEqual(rows(), ['finished'])
    const search = document.querySelector<HTMLInputElement>('[aria-label="Find threads"]')
    assert.ok(search)
    search.value = 'missing'
    search.dispatchEvent(new Event('input'))
    assert.deepEqual(rows(), [])
    find('.thread-browser-reset').click()
    assert.equal(rows().length, 5)
  })

  it('sorts both directions and preserves the changes filter', async () => {
    mount()
    await delay(80)
    find('.thread-work-filter').click()
    const sortSelect = document.querySelector<HTMLSelectElement>('[aria-label="Sort threads"]')
    assert.ok(sortSelect)
    sortSelect.value = 'updated'
    sortSelect.dispatchEvent(new Event('change'))
    find('.thread-browser-sort-direction').click()
    assert.deepEqual(rows(), ['finished', 'other-project'])
    find('.thread-browser-sort-direction').click()
    assert.deepEqual(rows(), ['other-project', 'finished'])
    assert.equal(find('.thread-work-filter').getAttribute('aria-pressed'), 'true')
  })

  it('groups changed work below activity without duplicating active dirty threads', async () => {
    const fixture = mount()
    fixture.api.git.status = async (): Promise<GitStatusResult> => dirty
    fixture.changed()
    await delay(1150)
    assert.deepEqual(
      [...document.querySelectorAll<HTMLElement>('[data-group]')].map(
        (group) => group.dataset['group'],
      ),
      ['needs-you', 'working', 'changes'],
    )
    assert.equal(rows().length, new Set(rows()).size)
    assert.equal(find('[data-group="needs-you"] .thread-browser-work').textContent, '2 files')
    assert.equal(find('[data-group="working"] .thread-browser-work').textContent, '2 files')
    assert.ok(find('[data-group="changes"] .thread-work-filter'))
    find('.thread-work-filter').click()
    assert.equal(rows().length, 5)
    find('.thread-attention-filter').click()
    assert.deepEqual(rows(), ['waiting'])
    find('.thread-working-filter').click()
    assert.deepEqual(rows(), ['working'])
  })

  it('collapses the changes section without hiding its filter control', async () => {
    mount()
    await delay(80)
    find('[data-group="changes"] .thread-browser-group-heading').click()
    assert.equal(document.querySelector('[data-group="changes"] .thread-browser-row'), null)
    assert.ok(find('.thread-work-filter'))
    find('[data-group="changes"] .thread-browser-group-heading').click()
    assert.ok(find('[data-group="changes"] .thread-browser-row'))
  })

  it('shows unavailable status and updates dirty filters after checkout changes', async () => {
    const fixture = mount()
    await delay(80)
    assert.equal(
      find('[data-thread-id="unknown"] .thread-browser-work').title,
      'Git status unavailable',
    )
    find('.thread-work-filter').click()
    fixture.api.git.status = async (): Promise<GitStatusResult> => clean
    fixture.changed()
    await delay(1150)
    assert.deepEqual(rows(), [])
  })

  it('opens the existing project management surface and returns to threads', () => {
    mount()
    find('.thread-browser-manage').click()
    assert.equal(find('.thread-browser').hidden, true)
    assert.ok(document.querySelector('.projects-add-btn'))
    find('.thread-browser-back').click()
    assert.equal(find('.thread-browser').hidden, false)
  })

  it('waits for project restoration before creating a thread', async () => {
    const fixture = mount(null)
    const newThread = document.querySelector<HTMLButtonElement>('[aria-label="New thread"]')
    assert.ok(newThread)
    assert.equal(newThread.disabled, true)
    newThread.click()
    assert.equal(fixture.store.getState().activeThreadId, 'waiting')
    assert.equal(fixture.store.getState().threads.length, 4)

    fixture.store.setState({
      workspaceRoot: '/first',
      activeThreadId: 'restored',
      threads: [
        thread('restored', 1, {
          messages: [
            { id: 'prompt', role: 'user', content: 'Existing work', toolCalls: [], createdAt: 1 },
          ],
        }),
      ],
    })
    fixture.store.emit('workspace_changed')
    await delay(50)
    assert.equal(newThread.disabled, false)
    newThread.click()
    assert.notEqual(fixture.store.getState().activeThreadId, 'restored')
    assert.equal(fixture.store.getState().threads.length, 2)
  })

  function menuLabels(): string[] {
    return [...document.querySelectorAll<HTMLElement>('.context-menu-item')].map(
      (item) => item.textContent,
    )
  }

  function chooseMenuItem(label: string): void {
    const item = [...document.querySelectorAll<HTMLButtonElement>('.context-menu-item')].find(
      (button) => button.textContent === label,
    )
    assert.ok(item, label)
    item.click()
  }

  function rightClick(selector: string): void {
    find(selector).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }),
    )
  }

  it('renames, archives and deletes active-project threads from the row menu', async () => {
    const fixture = mount()
    await delay(80)
    rightClick('[data-thread-id="finished"]')
    assert.deepEqual(menuLabels(), ['Rename', 'Fork', 'Archive', 'Delete'])
    chooseMenuItem('Rename')
    const input = document.querySelector<HTMLInputElement>('.chat-title-rename')
    assert.ok(input)
    assert.equal(document.activeElement, input)
    // Live updates must not rebuild the row out from under the open input.
    fixture.store.emit('threads_changed')
    fixture.changed()
    await delay(1150)
    assert.equal(document.querySelector('.chat-title-rename'), input)
    assert.equal(document.activeElement, input)
    input.value = 'Renamed work'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await delay(30)
    assert.equal(find('[data-thread-id="finished"] .chat-title').textContent, 'Renamed work')

    rightClick('[data-thread-id="finished"]')
    chooseMenuItem('Archive')
    await delay(30)
    assert.equal(document.querySelector('[data-thread-id="finished"]'), null)

    rightClick('[data-thread-id="unknown"]')
    chooseMenuItem('Delete')
    await delay(30)
    assert.equal(document.querySelector('[data-thread-id="unknown"]'), null)
    assert.equal(
      fixture.store.getState().threads.some((item) => item.id === 'unknown'),
      false,
    )
  })

  it('offers to open another project before changing its threads', async () => {
    mount()
    await delay(80)
    rightClick('[data-thread-id="other-project"]')
    assert.deepEqual(menuLabels(), ['Open thread'])
    find('[data-thread-id="other-project"] .chat-title').dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true }),
    )
    assert.equal(document.querySelector('.chat-title-rename'), null)
  })

  it('shows PR status on rows across projects', async () => {
    const fixture = mount()
    const prRefs = [
      {
        owner: 'copse-dev',
        repo: 'agent-pane',
        number: 42,
        url: 'https://github.com/copse-dev/agent-pane/pull/42',
      },
    ]
    const lookups: number[] = []
    fixture.api.gh.prDetails = async (owner, repo, number): Promise<GhPrDetails> => {
      lookups.push(number)
      return {
        owner,
        repo,
        number,
        title: 'Linked work',
        url: `https://github.com/${owner}/${repo}/pull/${String(number)}`,
        state: 'OPEN',
        body: '',
        files: [],
      }
    }
    await delay(80)
    fixture.api.threads.loadProject = async (): Promise<Thread[]> => [
      thread('other-project', 6, { prRefs }),
    ]
    find('.thread-browser-footer button').click()
    await delay(80)
    assert.equal(
      find('[data-thread-id="other-project"] .chat-pr-status').getAttribute('aria-label'),
      'Pull request #42 is open',
    )
    assert.deepEqual(lookups, [42])
  })

  it('matches saved requests in every project, not just titles', async () => {
    const fixture = mount()
    fixture.api.threads.loadMessages = async (projectId, threadId): Promise<Message[]> =>
      projectId === 'two' && threadId === 'other-project'
        ? [
            {
              id: 'm',
              role: 'user',
              content: 'Please fix the flaky tokenizer',
              toolCalls: [],
              createdAt: 1,
            },
          ]
        : []
    await delay(80)
    const search = document.querySelector<HTMLInputElement>('[aria-label="Find threads"]')
    assert.ok(search)
    search.value = 'tokenizer'
    search.dispatchEvent(new Event('input'))
    assert.deepEqual(rows(), [])
    await delay(400)
    assert.deepEqual(rows(), ['other-project'])
    search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    assert.equal(search.value, '')
    assert.equal(rows().length, 5)
  })

  it('surfaces quarantined projects and recoverable threads without opening Projects', async () => {
    const api = createFakeApi()
    api.threads.listOrphans = async (): Promise<OrphanProjectStore[]> => [
      { id: 'orphan', threadCount: 2, updatedAt: 1, sampleTitles: ['Lost plan', 'Notes'] },
    ]
    const store = createStore({
      projects: [
        { id: 'one', name: 'First', path: '/first' },
        { id: 'gone', name: 'Gone', path: '/gone', missing: true },
      ],
      activeProjectId: 'one',
      workspaceRoot: '/first',
      threads: [thread('only', 1)],
    })
    const root = document.createElement('div')
    document.body.append(root)
    const sources: ActivitySources = {
      approvals: { pending: () => [], onChange: () => () => {}, answerOnce: () => false },
      questions: { pending: () => [], onChange: () => () => {} },
    }
    dispose = mountThreadSidebar(root, store, api, sources)
    await delay(80)
    assert.equal(
      find('.thread-browser-notice[data-project-id="gone"] .project-missing-btn').textContent,
      'Relocate…',
    )
    assert.equal(find('.orphans-section .orphan-name').textContent, 'Lost plan')
    assert.ok(find('.orphans-section .orphan-recover-btn'))
  })

  it('scopes the project menu to the chosen project and keeps the zero count calm', async () => {
    const fixture = mount()
    await delay(80)
    const menu = document.querySelector<HTMLButtonElement>('.thread-browser-project-menu')
    assert.ok(menu)
    assert.equal(menu.hidden, true)
    const projects = document.querySelector<HTMLSelectElement>('[aria-label="Filter by project"]')
    assert.ok(projects)
    projects.value = 'two'
    projects.dispatchEvent(new Event('change'))
    assert.equal(menu.hidden, false)
    assert.equal(menu.disabled, false)
    assert.equal(menu.getAttribute('aria-label'), 'Project menu for Second')
    assert.equal(find('.thread-attention-filter').classList.contains('is-empty'), false)
    fixture.answer()
    await delay(50)
    assert.equal(find('.thread-attention-filter').classList.contains('is-empty'), true)
  })

  it('offers add-project, automation and activity actions from the header', async () => {
    mount()
    await delay(20)
    find('.thread-browser-more').click()
    assert.deepEqual(menuLabels(), ['New project', 'Open folder', 'New automation…', 'Activity'])
  })

  it('keeps keyboard focus on the changes filter as the list re-renders', async () => {
    mount()
    await delay(80)
    const toggle = find('.thread-work-filter')
    toggle.focus()
    toggle.click()
    assert.equal(document.activeElement, toggle)
    find('[data-group-heading="changes"]').focus()
    find('[data-group-heading="changes"]').click()
    assert.equal(document.activeElement, find('[data-group-heading="changes"]'))
  })

  it('keeps live rows when an update changes nothing they show', async () => {
    const fixture = mount()
    await delay(80)
    const row = find('[data-thread-id="finished"]')
    fixture.store.emit('threads_changed')
    await delay(50)
    assert.equal(find('[data-thread-id="finished"]'), row)
    fixture.store.setState({
      threads: fixture.store
        .getState()
        .threads.map((item) => (item.id === 'finished' ? { ...item, title: 'Retitled' } : item)),
    })
    fixture.store.emit('threads_changed')
    await delay(50)
    assert.notEqual(find('[data-thread-id="finished"]'), row)
    assert.equal(find('[data-thread-id="finished"] .chat-title').textContent, 'Retitled')
  })

  it('counts unique paths and includes untracked-only work', () => {
    assert.deepEqual(summarizeThreadWork(dirty), { count: 2, staged: 1, unstaged: 1, untracked: 1 })
    assert.deepEqual(
      summarizeThreadWork({ staged: [], unstaged: [{ path: 'new', status: 'untracked' }] }),
      { count: 1, staged: 0, unstaged: 0, untracked: 1 },
    )
  })
})
