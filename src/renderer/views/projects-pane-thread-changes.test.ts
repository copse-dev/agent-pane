// Sidebar rows show a muted branch glyph for a finished thread that has unlanded
// work and no PR; the detail is the tooltip / aria-label only.
import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ThreadChangeSummary } from '@shared/types/git.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountProjectsPane } from './projects-pane.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

type SidebarTestThread = Thread & { prRefs: never[] }

function thread(id: string, title: string, status: Thread['status'] = 'idle'): SidebarTestThread {
  return {
    id,
    title,
    status,
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    prRefs: [],
  }
}

function apiWithSummaries(
  summaries: Record<string, ThreadChangeSummary | null>,
  asked: string[][] = [],
): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    threads: { ...base['threads'], listOrphans: async (): Promise<never[]> => [] },
    git: {
      ...base['git'],
      threadChangeSummary: async (refs): Promise<Array<ThreadChangeSummary | null>> => {
        asked.push(refs.map((ref) => ref.threadId))
        return refs.map((ref) => summaries[ref.threadId] ?? null)
      },
    },
  } satisfies ApiClient
}

function mount(threads: Thread[], api: ApiClient): void {
  const store = createStore({
    projects: [{ id: 'p1', path: '/proj', name: 'Proj' }],
    activeProjectId: 'p1',
    threads,
  })
  const host = document.createElement('div')
  document.body.append(host)
  mountProjectsPane(host, store, api)
}

function rowByTitle(title: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('.chat-row')).find(
    (r) => r.querySelector('.chat-title')?.textContent === title,
  )
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('projects pane thread changes glyph (component)', () => {
  it('labels unpushed commits and uncommitted changes, and leaves clean rows bare', async () => {
    const asked: string[][] = []
    mount(
      [
        thread('a', 'Has commits'),
        thread('b', 'Dirty tree'),
        thread('c', 'Clean'),
        thread('d', 'Still running', 'running'),
      ],
      apiWithSummaries(
        { a: { dirty: false, unpushed: 2 }, b: { dirty: true }, c: { dirty: false } },
        asked,
      ),
    )
    await settle()

    const labelOf = (title: string): string | null =>
      rowByTitle(title)?.querySelector('.chat-changes-status')?.getAttribute('aria-label') ?? null
    assert.equal(labelOf('Has commits'), '2 unpushed commits')
    assert.equal(labelOf('Dirty tree'), 'Uncommitted changes')
    assert.equal(labelOf('Clean'), null)
    assert.equal(labelOf('Still running'), null)
    assert.equal(
      rowByTitle('Has commits')
        ?.querySelector('.chat-changes-status')
        ?.getAttribute('data-tooltip'),
      '2 unpushed commits',
    )
    // Running rows are never asked about, and a settled read is not repeated.
    assert.deepEqual(asked, [['a', 'b', 'c']])
  })
})
