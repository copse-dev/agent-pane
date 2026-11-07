// The sort menu's Group by choice lays threads out under their projects, in
// status sections across projects, or as one flat list, and remembers it.
import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../preload/api.d.ts'
import { createStore } from '@shared/store/store.ts'
import type { ThreadGroupMode } from '@shared/types/state.ts'
import type { Thread } from '@shared/types'
import { mountProjectsPane } from './projects-pane.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { setAttentionThreads, resetAttention } from '../controller/attention.ts'

function thread(id: string, title: string, status: Thread['status'] = 'idle'): Thread {
  return {
    id,
    title,
    status,
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

const disposers: Array<() => void> = []

function mount(
  group: ThreadGroupMode,
  threads: Thread[] = [
    thread('idle', 'Idle one'),
    thread('run', 'Runner', 'running'),
    thread('ask', 'Asker'),
  ],
): {
  store: ReturnType<typeof createStore>
  saved: Array<[string, unknown]>
} {
  const saved: Array<[string, unknown]> = []
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    threads: { ...base['threads'], listOrphans: async (): Promise<never[]> => [] },
    settings: {
      ...base['settings'],
      set: (key, value): Promise<void> => {
        saved.push([key, value])
        return Promise.resolve()
      },
    },
  }
  const store = createStore({
    projects: [
      { id: 'p1', path: '/work', name: 'work' },
      { id: 'p2', path: '/other', name: 'other' },
    ],
    activeProjectId: 'p1',
    expandedProjectId: 'p1',
    workspaceRoot: '/work',
    threads,
    activeThreadId: threads[0]?.id ?? null,
    sidebarThreadGroup: group,
  })
  const host = document.createElement('div')
  document.body.append(host)
  disposers.push(mountProjectsPane(host, store, api))
  return { store, saved }
}

const headings = (): string[] =>
  Array.from(document.querySelectorAll('.thread-section-heading')).map((n) => n.textContent)
const titles = (): string[] =>
  Array.from(document.querySelectorAll('.chat-row .chat-title')).map((n) => n.textContent)

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  resetAttention()
  document.body.replaceChildren()
})

describe('projects pane group by (component)', () => {
  it('keeps the project tree by default', () => {
    mount('project')
    assert.ok(document.querySelector('.project-row'))
    assert.deepEqual(headings(), [])
  })

  it('splits threads into Needs you, Working and Recent', () => {
    const { store } = mount('status')
    setAttentionThreads(store, 'ask', ['ask'])
    assert.equal(document.querySelector('.project-twisty'), null)
    assert.deepEqual(headings(), ['Needs you', 'Working', 'Recent'])
    assert.deepEqual(titles(), ['Asker', 'Runner', 'Idle one'])
  })

  it('gives status titles their own line above creation age and project', () => {
    const now = Date.now()
    const hourOld = {
      ...thread('hour', 'A longer title with room to read'),
      createdAt: now - 3_600_000,
      updatedAt: now,
    }
    const dayOld = {
      ...thread('day', 'Started yesterday'),
      createdAt: now - 86_400_000,
      updatedAt: now,
    }
    mount('status', [hourOld, dayOld])
    const row = document.querySelector('.chat-row[data-thread-id="hour"]')
    assert.ok(row)
    assert.equal(
      row.querySelector('.chat-thread-content > .chat-title')?.textContent,
      hourOld.title,
    )
    assert.equal(row.querySelector('.chat-thread-details .chat-thread-age')?.textContent, '1h')
    assert.equal(
      row.querySelector('.chat-thread-details .chat-thread-owner')?.textContent,
      '· work',
    )
    assert.equal(
      row.querySelector('time')?.getAttribute('datetime'),
      new Date(hourOld.createdAt).toISOString(),
    )
    assert.equal(
      document.querySelector('.chat-row[data-thread-id="day"] .chat-thread-age')?.textContent,
      '1d',
    )
    assert.equal(row.querySelector('time')?.getAttribute('aria-label'), 'Started 1 hour ago')
  })

  it('reads a thread started under a minute ago as started just now', () => {
    const now = Date.now()
    mount('status', [{ ...thread('new', 'Fresh thread'), createdAt: now - 5_000, updatedAt: now }])
    const age = document.querySelector('.chat-row[data-thread-id="new"] .chat-thread-age')
    assert.ok(age)
    assert.equal(age.textContent, 'now')
    assert.equal(age.getAttribute('aria-label'), 'Started just now')
  })

  it('keeps the project tree on one line without status metadata', () => {
    mount('project')
    assert.equal(document.querySelector('.chat-thread-content'), null)
    assert.equal(document.querySelector('.chat-thread-age'), null)
  })

  it('lists every thread flat, each naming its project', () => {
    mount('none')
    assert.deepEqual(headings(), [])
    assert.equal(titles().length, 3)
    assert.equal(document.querySelectorAll('.chat-thread-owner').length, 3)
    assert.equal(document.querySelector('.chat-thread-owner')?.textContent, '· work')
    // The label sits in the row right after the title, where the row CSS lets the title give way first.
    const owner = document.querySelector('.chat-row > .chat-title + .chat-thread-owner')
    assert.ok(owner, 'the owner label follows the title inside the row')
  })

  it('applies and persists the choice from the menu', () => {
    const { store, saved } = mount('project')
    document.querySelector<HTMLButtonElement>('.projects-sort-btn')?.click()
    const item = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.context-menu-item'),
    ).find((button) => button.textContent === 'Status')
    assert.ok(item, 'the menu offers Status')
    item.click()
    assert.equal(store.getState().sidebarThreadGroup, 'status')
    assert.deepEqual(saved, [['sidebarThreadGroup', 'status']])
    assert.equal(document.querySelector('.project-twisty'), null)
  })

  describe('an empty project', () => {
    const projectNames = (): string[] =>
      Array.from(document.querySelectorAll('.project-entry .project-name')).map(
        (n) => n.textContent,
      )

    for (const group of ['status', 'none'] as const) {
      it(`keeps its row and "+" in ${group} grouping, and "+" starts a thread`, () => {
        const { store } = mount(group, [])
        assert.equal(document.querySelector('.sidebar-empty')?.textContent, 'No threads yet')
        assert.deepEqual(projectNames(), ['work', 'other'])
        const plus = document.querySelector<HTMLButtonElement>(
          '.project-entry[data-project-id="p1"] .project-new-thread-btn',
        )
        assert.ok(plus, 'the active project has a "+"')
        plus.click()
        assert.equal(store.getState().threads.length, 1)
      })
    }

    for (const group of ['status', 'none'] as const) {
      it(`keeps its row and "+" in ${group} grouping beside a project that has threads`, () => {
        const { store } = mount(group)
        assert.equal(titles().length, 3)
        assert.equal(document.querySelector('.sidebar-empty'), null)
        assert.deepEqual(projectNames(), ['other'])
        document
          .querySelector<HTMLButtonElement>(
            '.project-entry[data-project-id="p2"] .project-new-thread-btn',
          )
          ?.click()
        assert.equal(store.getState().expandedProjectId, 'p2')
      })
    }

    it('shows a quiet hint in project grouping', () => {
      mount('project', [])
      assert.equal(
        document.querySelector('.chats-list .sidebar-empty')?.textContent,
        'No threads yet',
      )
    })
  })
})
