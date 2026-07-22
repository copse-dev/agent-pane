// Sidebar thread rows show a compact GitHub PR lifecycle chip (#42 / 2 open /
// merged) once linked PR details resolve via the mock/gh backend.
import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { GhPrDetails } from '@shared/types/git.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountProjectsPane } from './projects-pane.ts'

// Mirror gh-pr-mock fixtures (keep renderer tests free of main-process imports).
const OWNER = 'copse-dev'
const REPO = 'copse-panel'
const OPEN_NUMBER = 42
const MERGED_NUMBER = 99
const OPEN_URL = `https://github.com/${OWNER}/${REPO}/pull/${String(OPEN_NUMBER)}`
const MERGED_URL = `https://github.com/${OWNER}/${REPO}/pull/${String(MERGED_NUMBER)}`

function thread(
  id: string,
  title: string,
  overrides: Partial<Pick<Thread, 'messages' | 'remoteAgentLink'>> = {},
): Thread {
  const base: Thread = {
    id,
    title,
    status: 'idle',
    messages: overrides.messages ?? [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
  if (overrides.remoteAgentLink) base.remoteAgentLink = overrides.remoteAgentLink
  return base
}

function assistant(id: string, content: string): Thread['messages'][number] {
  return { id, role: 'assistant', content, toolCalls: [], createdAt: 1 }
}

function details(number: number, state: string): GhPrDetails {
  return {
    owner: OWNER,
    repo: REPO,
    number,
    title: `PR ${String(number)}`,
    url: `https://github.com/${OWNER}/${REPO}/pull/${String(number)}`,
    state,
    body: '',
    files: [],
  }
}

function apiWithPrDetails(
  resolve: (owner: string, repo: string, number: number) => Promise<GhPrDetails | null>,
): ApiClient {
  return {
    threads: {
      listOrphans: async (): Promise<never[]> => [],
    },
    gh: {
      prDetails: resolve,
    },
  } as unknown as ApiClient
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('projects pane thread PR status (component)', () => {
  function mount(store: ReturnType<typeof createStore>, api: ApiClient): HTMLElement {
    const host = document.createElement('div')
    document.body.append(host)
    mountProjectsPane(host, store, api)
    return host
  }

  function rowByTitle(title: string): HTMLElement | undefined {
    return Array.from(document.querySelectorAll<HTMLElement>('.chat-row')).find(
      (r) => r.querySelector('.chat-title')?.textContent === title,
    )
  }

  async function waitForChip(title: string, text: string): Promise<HTMLElement> {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const row = rowByTitle(title)
      const chip = row?.querySelector<HTMLElement>('.chat-pr-status')
      if (chip?.textContent === text) return chip
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(`Timed out waiting for PR chip "${text}" on "${title}"`)
  }

  it('shows #N for a single open PR linked from chat', async () => {
    const store = createStore({
      projects: [{ id: 'p1', path: '/proj', name: 'Proj' }],
      activeProjectId: 'p1',
      expandedProjectId: 'p1',
      workspaceRoot: '/proj',
      threads: [
        thread('open', 'Open PR work', {
          messages: [assistant('m1', `Opened ${OPEN_URL}`)],
        }),
        thread('plain', 'No PR'),
      ],
      activeThreadId: 'open',
    })
    mount(
      store,
      apiWithPrDetails(async (_o, _r, number) =>
        number === OPEN_NUMBER ? details(number, 'OPEN') : null,
      ),
    )

    const chip = await waitForChip('Open PR work', `#${String(OPEN_NUMBER)}`)
    assert.ok(chip.classList.contains('is-open'))
    assert.match(chip.getAttribute('aria-label') ?? '', /open/i)
    assert.equal(rowByTitle('No PR')?.querySelector('.chat-pr-status'), null)
  })

  it('shows all merged when every linked PR is merged', async () => {
    const store = createStore({
      projects: [{ id: 'p1', path: '/proj', name: 'Proj' }],
      activeProjectId: 'p1',
      expandedProjectId: 'p1',
      workspaceRoot: '/proj',
      threads: [
        thread('done', 'Shipped work', {
          messages: [assistant('m1', `Landed ${MERGED_URL} and ${OPEN_URL}`)],
          remoteAgentLink: {
            provider: 'cursor',
            agentId: 'a1',
            prUrl: MERGED_URL,
            createdAt: 1,
          },
        }),
      ],
      activeThreadId: 'done',
    })
    mount(
      store,
      apiWithPrDetails(async (_o, _r, number) => {
        if (number === MERGED_NUMBER) return details(number, 'MERGED')
        if (number === OPEN_NUMBER) return details(number, 'MERGED')
        return null
      }),
    )

    const chip = await waitForChip('Shipped work', 'all merged')
    assert.ok(chip.classList.contains('is-merged'))
  })

  it('counts multiple open PRs as N open', async () => {
    const store = createStore({
      projects: [{ id: 'p1', path: '/proj', name: 'Proj' }],
      activeProjectId: 'p1',
      expandedProjectId: 'p1',
      workspaceRoot: '/proj',
      threads: [
        thread('multi', 'Multi-PR thread', {
          messages: [assistant('m1', `${OPEN_URL} and ${MERGED_URL}`)],
        }),
      ],
      activeThreadId: 'multi',
    })
    mount(
      store,
      apiWithPrDetails(async (_o, _r, number) => {
        if (number === OPEN_NUMBER) return details(number, 'OPEN')
        if (number === MERGED_NUMBER) return details(number, 'OPEN')
        return null
      }),
    )

    const chip = await waitForChip('Multi-PR thread', '2 open')
    assert.ok(chip.classList.contains('is-open'))
  })
})
