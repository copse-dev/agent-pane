// "Needs cleanup only" in the Show menu narrows the sidebar to threads with
// unlanded work: an open PR, or uncommitted/unpushed changes. A thread whose
// PR/change state hasn't resolved yet still shows, so the filter never hides
// something before it has had a chance to classify it.
import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ThreadChangeSummary, GhPrDetails } from '@shared/types/git.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountProjectsPane } from './projects-pane.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

function thread(id: string, title: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    title,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    prRefs: [],
    ...overrides,
  }
}

function apiWithSummaries(summaries: Record<string, ThreadChangeSummary | null>): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    threads: { ...base['threads'], listOrphans: async (): Promise<never[]> => [] },
    git: {
      ...base['git'],
      threadChangeSummary: async (refs): Promise<Array<ThreadChangeSummary | null>> =>
        refs.map((ref) => summaries[ref.threadId] ?? null),
    },
  } satisfies ApiClient
}

function mount(threads: Thread[], api: ApiClient): void {
  const store = createStore({
    projects: [{ id: 'p1', path: '/proj', name: 'Proj' }],
    activeProjectId: 'p1',
    expandedProjectId: 'p1',
    workspaceRoot: '/proj',
    threads,
  })
  const host = document.createElement('div')
  document.body.append(host)
  mountProjectsPane(host, store, api)
}

function titles(): string[] {
  return Array.from(document.querySelectorAll('.chats-list .chat-title')).map((n) => n.textContent)
}

function toggleNeedsCleanup(): void {
  document.querySelector<HTMLButtonElement>('.projects-filter-btn')?.click()
  const item = Array.from(document.querySelectorAll<HTMLButtonElement>('.context-menu-item')).find(
    (button) => button.textContent === 'Needs cleanup only',
  )
  assert.ok(item, 'the Show menu offers "Needs cleanup only"')
  item.click()
}

function emptyMessage(): string | null {
  return document.querySelector('.chats-list .sidebar-empty')?.textContent ?? null
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('projects pane needs-cleanup filter (component)', () => {
  it('narrows to dirty/unpushed threads and restores the full list when toggled off', async () => {
    mount(
      [
        thread('a', 'Has commits'),
        thread('b', 'Dirty tree'),
        thread('c', 'Clean'),
        thread('d', 'Still running', { status: 'running' }),
      ],
      apiWithSummaries({
        a: { dirty: false, unpushed: 2 },
        b: { dirty: true },
        c: { dirty: false },
      }),
    )
    await settle()

    toggleNeedsCleanup()
    assert.deepEqual(titles().sort(), ['Dirty tree', 'Has commits'])

    toggleNeedsCleanup()
    assert.deepEqual(
      titles().sort(),
      ['Clean', 'Dirty tree', 'Has commits', 'Still running'].sort(),
    )
  })

  it('keeps an unclassified thread visible until its change summary resolves', async () => {
    let resolveSummary: ((value: Array<ThreadChangeSummary | null>) => void) | undefined
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      threads: { ...base['threads'], listOrphans: async (): Promise<never[]> => [] },
      git: {
        ...base['git'],
        threadChangeSummary: (): Promise<Array<ThreadChangeSummary | null>> =>
          new Promise((resolve) => {
            resolveSummary = resolve
          }),
      },
    }
    mount([thread('a', 'Pending check')], api)
    await settle()

    toggleNeedsCleanup()
    assert.deepEqual(titles(), ['Pending check'], 'not yet classified, so still shown')

    resolveSummary?.([{ dirty: false }])
    await settle()
    assert.deepEqual(titles(), [], 'resolved clean, so now filtered out')
  })

  it('counts an open linked PR as needing cleanup', async () => {
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      threads: { ...base['threads'], listOrphans: async (): Promise<never[]> => [] },
      git: { ...base['git'], threadChangeSummary: apiWithSummaries({}).git.threadChangeSummary },
      gh: {
        ...base['gh'],
        prDetails: (): Promise<GhPrDetails> =>
          Promise.resolve({
            owner: 'copse-dev',
            repo: 'copse-panel',
            number: 7,
            title: 'PR 7',
            url: 'https://github.com/copse-dev/copse-panel/pull/7',
            state: 'OPEN',
            body: '',
            files: [],
          }),
      },
    }
    mount(
      [
        thread('a', 'Open PR', {
          messages: [
            {
              id: 'm',
              role: 'assistant',
              content: 'https://github.com/copse-dev/copse-panel/pull/7',
              toolCalls: [],
              createdAt: 1,
            },
          ],
        }),
        thread('b', 'No PR, clean'),
      ],
      api,
    )
    await settle()

    toggleNeedsCleanup()
    await settle()
    assert.deepEqual(titles(), ['Open PR'])
  })

  it('shows a dedicated empty state and marks the Show button as filtering', async () => {
    mount([thread('a', 'Clean')], apiWithSummaries({ a: { dirty: false } }))
    await settle()

    toggleNeedsCleanup()
    assert.equal(emptyMessage(), 'Nothing needs cleanup')
    assert.equal(
      document.querySelector('.projects-filter-btn')?.classList.contains('is-filtering'),
      true,
    )
  })
})
