import '../../../tests/setup-dom.ts'
import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GhCliStatus, GhPrDetails, GhPrSummary } from '@shared/types/git.ts'
import { mountPrPane } from './pr-pane.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import type { GitDiffMonaco } from '../monaco/git-diff-viewer.ts'

const noopUnsub = (): (() => void) => () => {}

function unreachableMonacoCall(): never {
  throw new Error('title tests must not create a Monaco diff editor')
}

const MONACO_STUB: GitDiffMonaco = {
  KeyCode: { KeyL: 0 },
  Uri: { parse: (value) => ({ toString: () => value }) },
  editor: {
    createDiffEditor: unreachableMonacoCall,
    createModel: unreachableMonacoCall,
  },
}

const READY: GhCliStatus = { installed: true, authenticated: true, username: 'me', message: null }

function makeThread(id: string, message: string): Thread {
  return {
    id,
    title: 'Thread',
    status: 'idle',
    messages: [{ id: 'm1', role: 'user', content: message, toolCalls: [], createdAt: Date.now() }],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function linkedPr(number: number): GhPrSummary {
  return {
    owner: 'acme',
    repo: 'widgets',
    number,
    title: 'Improve documentation',
    url: `https://github.com/acme/widgets/pull/${String(number)}`,
    state: 'OPEN',
    headRefName: 'docs-update',
    authorLogin: 'bob',
  }
}

function mount(
  prDetails: (owner: string, repo: string, number: number) => Promise<GhPrDetails | null>,
  number: number,
): {
  listRoot: HTMLElement
  unmount: () => void
} {
  const store = createStore({
    activeProjectId: 'project-1',
    activeThreadId: 'thread-1',
    filesPaneOpen: true,
    rightPanelMode: 'prs',
    threads: [makeThread('thread-1', `See https://github.com/acme/widgets/pull/${String(number)}`)],
  })
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    gh: {
      ...base['gh'],
      status: async () => READY,
      agentPrLinks: async () => [],
      onListsTick: noopUnsub,
      setListWatch: async () => undefined,
      listWorkspaceOpenPrs: async () => [],
      listMyOpenPrs: async () => [],
      prChecks: async () => 'no_checks',
      prDetails,
    },
  }
  const listRoot = document.createElement('div')
  const viewerRoot = document.createElement('div')
  document.body.append(listRoot, viewerRoot)
  const unmount = mountPrPane(listRoot, viewerRoot, store, api, MONACO_STUB)
  return { listRoot, unmount }
}

/** Drain microtasks and the deferred title-repaint timer. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function rowTitles(listRoot: HTMLElement): string[] {
  return [...listRoot.querySelectorAll('.pr-list-title')].map((el) => el.textContent)
}

before(() => {
  if (!('ResizeObserver' in globalThis)) {
    class NoopResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = NoopResizeObserver
  }
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('pr pane titles for unenriched chat-linked rows', () => {
  it('fills the real title into a placeholder row via details lookup', async () => {
    const number = 42
    const { listRoot, unmount } = mount(
      async () => ({
        ...linkedPr(number),
        title: 'Anchor annotations to the page',
        body: '',
        files: [],
      }),
      number,
    )
    try {
      await settle()
      assert.deepEqual(rowTitles(listRoot), ['Anchor annotations to the page'])
    } finally {
      unmount()
    }
  })

  it('keeps the repo fallback when the details lookup fails', async () => {
    const number = 43
    const { listRoot, unmount } = mount(async () => {
      throw new Error('rate limited')
    }, number)
    try {
      await settle()
      assert.deepEqual(rowTitles(listRoot), ['acme/widgets'])
    } finally {
      unmount()
    }
  })

  it('does not re-request titles once the row is enriched', async () => {
    const number = 44
    let calls = 0
    const { listRoot, unmount } = mount(async () => {
      calls += 1
      return {
        ...linkedPr(number),
        title: 'Anchor annotations to the page',
        body: '',
        files: [],
      }
    }, number)
    try {
      await settle()
      // Title enrichment and the auto-selected details load both call prDetails
      // once; the important invariant is that later paints do not add more.
      assert.ok(calls >= 1)
      assert.deepEqual(rowTitles(listRoot), ['Anchor annotations to the page'])
      const afterFirstPaint = calls
      const filter = listRoot.querySelector<HTMLInputElement>('.pr-pane-filter')
      assert.ok(filter)
      filter.value = 'Anchor'
      filter.dispatchEvent(new Event('input', { bubbles: true }))
      await settle()
      assert.equal(calls, afterFirstPaint)
      assert.deepEqual(rowTitles(listRoot), ['Anchor annotations to the page'])
    } finally {
      unmount()
    }
  })
})
