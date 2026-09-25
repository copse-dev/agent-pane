import '../../../tests/setup-dom.ts'
import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GhCliStatus, GhPrSummary } from '@shared/types/git.ts'
import { mountPrPane } from './pr-pane.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import type { GitDiffMonaco } from '../monaco/git-diff-viewer.ts'

const noopUnsub = (): (() => void) => () => {}

function unreachableMonacoCall(): never {
  throw new Error('filter tests must not create a Monaco diff editor')
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

// Enriches the chat-linked ref (from-chat group), plus one more workspace PR
// (same-repo group) and one cross-repo PR only reachable once "Your open PRs"
// is expanded (other group) — all three groups the filter has to reach.
const LINKED_PR: GhPrSummary = {
  owner: 'acme',
  repo: 'widgets',
  number: 42,
  title: 'Fix login flow',
  url: 'https://github.com/acme/widgets/pull/42',
  state: 'OPEN',
  headRefName: 'fix/login',
  authorLogin: 'alice',
}
const WORKSPACE_PR: GhPrSummary = {
  owner: 'acme',
  repo: 'widgets',
  number: 55,
  title: 'Improve documentation',
  url: 'https://github.com/acme/widgets/pull/55',
  state: 'OPEN',
  headRefName: 'docs-update',
  authorLogin: 'bob',
}
const OTHER_PR: GhPrSummary = {
  owner: 'acme',
  repo: 'other-repo',
  number: 99,
  title: 'Refactor cache layer',
  url: 'https://github.com/acme/other-repo/pull/99',
  state: 'OPEN',
  headRefName: 'cache-refactor',
  authorLogin: 'carol',
}

function mount(otherPrs: readonly GhPrSummary[] = [OTHER_PR]): {
  listRoot: HTMLElement
  viewerRoot: HTMLElement
} {
  const store = createStore({
    activeProjectId: 'project-1',
    activeThreadId: 'thread-1',
    filesPaneOpen: true,
    rightPanelMode: 'prs',
    threads: [makeThread('thread-1', 'See https://github.com/acme/widgets/pull/42')],
  })
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    gh: {
      ...base['gh'],
      status: async () => READY,
      agentPrLinks: async () => [],
      onListsTick: noopUnsub,
      listWorkspaceOpenPrs: async () => [LINKED_PR, WORKSPACE_PR],
      listMyOpenPrs: async () => [...otherPrs],
      prChecks: async () => 'no_checks',
      prDetails: async () => null,
    },
  }
  const listRoot = document.createElement('div')
  const viewerRoot = document.createElement('div')
  document.body.append(listRoot, viewerRoot)
  mountPrPane(listRoot, viewerRoot, store, api, MONACO_STUB)
  return { listRoot, viewerRoot }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function rowTitles(listRoot: HTMLElement): string[] {
  return [...listRoot.querySelectorAll('.pr-list-title')].map((el) => el.textContent)
}

function sectionTitles(listRoot: HTMLElement): string[] {
  return [...listRoot.querySelectorAll('.git-changes-section-title')].map((el) => el.textContent)
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

describe('pr pane filter (issue #2482)', () => {
  it('renders a filter input and all three groups unfiltered', async () => {
    const { listRoot } = mount()
    await settle()

    const filter = listRoot.querySelector<HTMLInputElement>('.pr-pane-filter')
    assert.ok(filter, 'expected a .pr-pane-filter input')
    assert.equal(filter.placeholder, 'Filter pull requests')
    assert.deepEqual(rowTitles(listRoot), ['Fix login flow', 'Improve documentation'])
    assert.ok(sectionTitles(listRoot).some((t) => /from chat/i.test(t)))
    assert.ok(sectionTitles(listRoot).some((t) => /acme\/widgets/i.test(t)))
  })

  it('narrows the linked+workspace groups by title, branch, author, and PR number', async () => {
    const { listRoot } = mount()
    await settle()
    const filter = listRoot.querySelector<HTMLInputElement>('.pr-pane-filter')
    if (!filter) throw new Error('missing filter input')

    // Title match narrows to one row and hides the other group's header.
    filter.value = 'login'
    filter.dispatchEvent(new Event('input'))
    await settle()
    assert.deepEqual(rowTitles(listRoot), ['Fix login flow'])
    assert.ok(!sectionTitles(listRoot).some((t) => /acme\/widgets \(2\)/i.test(t)))

    // Branch name.
    filter.value = 'docs-update'
    filter.dispatchEvent(new Event('input'))
    await settle()
    assert.deepEqual(rowTitles(listRoot), ['Improve documentation'])

    // Author login, case-insensitive.
    filter.value = 'ALICE'
    filter.dispatchEvent(new Event('input'))
    await settle()
    assert.deepEqual(rowTitles(listRoot), ['Fix login flow'])

    // PR number with a leading #.
    filter.value = '#55'
    filter.dispatchEvent(new Event('input'))
    await settle()
    assert.deepEqual(rowTitles(listRoot), ['Improve documentation'])
  })

  it('reaches the lazily-loaded "other" group once expanded, and hides it when filtered out', async () => {
    const { listRoot } = mount()
    await settle()
    const otherToggle = listRoot.querySelector<HTMLButtonElement>('.pr-other-toggle')
    if (!otherToggle) throw new Error('missing other-PRs toggle')
    otherToggle.click()
    await settle()
    assert.ok(rowTitles(listRoot).includes('Refactor cache layer'))

    const filter = listRoot.querySelector<HTMLInputElement>('.pr-pane-filter')
    if (!filter) throw new Error('missing filter input')
    filter.value = 'cache'
    filter.dispatchEvent(new Event('input'))
    await settle()
    assert.deepEqual(rowTitles(listRoot), ['Refactor cache layer'])

    filter.value = 'nothing-matches-anything'
    filter.dispatchEvent(new Event('input'))
    await settle()
    assert.equal(rowTitles(listRoot).length, 0)
    assert.match(listRoot.textContent, /no pull requests match/i)
  })

  it('keeps the expanded empty other group filter-aware when nothing matches', async () => {
    const { listRoot } = mount([])
    await settle()
    const otherToggle = listRoot.querySelector<HTMLButtonElement>('.pr-other-toggle')
    if (!otherToggle) throw new Error('missing other-PRs toggle')
    otherToggle.click()
    await settle()

    const filter = listRoot.querySelector<HTMLInputElement>('.pr-pane-filter')
    if (!filter) throw new Error('missing filter input')
    filter.value = 'nothing-matches-anything'
    filter.dispatchEvent(new Event('input'))
    await settle()

    assert.equal(rowTitles(listRoot).length, 0)
    assert.equal(
      [...listRoot.querySelectorAll('.git-changes-empty')].filter((element) =>
        /no pull requests match/i.test(element.textContent),
      ).length,
      1,
    )
    assert.doesNotMatch(listRoot.textContent, /no other open pull requests/i)
  })

  it('shows an empty state when the query matches nothing, and Escape clears it while keeping focus', async () => {
    const { listRoot } = mount()
    await settle()
    const filter = listRoot.querySelector<HTMLInputElement>('.pr-pane-filter')
    if (!filter) throw new Error('missing filter input')
    filter.focus()

    filter.value = 'zzz-no-match'
    filter.dispatchEvent(new Event('input'))
    await settle()
    assert.equal(rowTitles(listRoot).length, 0)
    assert.match(listRoot.textContent, /no pull requests match/i)

    filter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    assert.equal(filter.value, '')
    assert.deepEqual(rowTitles(listRoot), ['Fix login flow', 'Improve documentation'])
    assert.equal(document.activeElement, filter)
  })
})
