import '../../../tests/setup-dom.ts'
import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GhCliStatus, GhPrChecksState, GhPrDetails, GhPrSummary } from '@shared/types/git.ts'
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

function mount(
  otherPrs: readonly GhPrSummary[] = [OTHER_PR],
  options: {
    linkedUrls?: string
    workspacePrs?: readonly GhPrSummary[]
    prDetails?: ApiClient['gh']['prDetails']
    prChecks?: ApiClient['gh']['prChecks']
  } = {},
): {
  listRoot: HTMLElement
  viewerRoot: HTMLElement
} {
  const store = createStore({
    activeProjectId: 'project-1',
    activeThreadId: 'thread-1',
    filesPaneOpen: true,
    rightPanelMode: 'prs',
    threads: [
      makeThread('thread-1', options.linkedUrls ?? 'See https://github.com/acme/widgets/pull/42'),
    ],
  })
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    gh: {
      ...base['gh'],
      status: async () => READY,
      agentPrLinks: async () => [],
      onListsTick: noopUnsub,
      listWorkspaceOpenPrs: async () => [...(options.workspacePrs ?? [LINKED_PR, WORKSPACE_PR])],
      listMyOpenPrs: async () => [...otherPrs],
      prChecks: options.prChecks ?? (async (): Promise<GhPrChecksState> => 'no_checks'),
      prDetails: options.prDetails ?? (async (): Promise<GhPrDetails | null> => null),
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
  it('loads conflict metadata for titled unselected rows in every visible group', async () => {
    const linked = { ...LINKED_PR, number: 801, url: 'https://github.com/acme/widgets/pull/801' }
    const secondLinked = {
      ...LINKED_PR,
      number: 804,
      url: 'https://github.com/acme/widgets/pull/804',
    }
    const workspace = { ...WORKSPACE_PR, number: 802 }
    const other = { ...OTHER_PR, number: 803 }
    const requests: number[] = []
    const { listRoot } = mount([other], {
      linkedUrls: `${linked.url} ${secondLinked.url}`,
      workspacePrs: [linked, secondLinked, workspace],
      prDetails: async (owner, repo, number) => {
        requests.push(number)
        return {
          owner,
          repo,
          number,
          title: `Titled PR ${String(number)}`,
          url: `https://github.com/${owner}/${repo}/pull/${String(number)}`,
          state: 'OPEN',
          mergeStateStatus: 'DIRTY',
          body: '',
          files: [],
        }
      },
      prChecks: async () => 'failure',
    })
    await settle()
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(!requests.includes(803), 'collapsed other group must stay lazy')
    listRoot.querySelector<HTMLButtonElement>('.pr-other-toggle')?.click()
    await settle()
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(
      listRoot.querySelectorAll('.pr-list-row[data-pr-section="linked"] .has-conflicts').length,
      2,
    )
    for (const section of ['linked', 'workspace', 'mine']) {
      const status = listRoot.querySelector(
        `.pr-list-row[data-pr-section="${section}"] .pr-list-status`,
      )
      assert.ok(status, section)
      assert.equal(status.classList.contains('has-conflicts'), true, section)
      assert.match(status.getAttribute('aria-label') ?? '', /merge conflicts; CI failing/)
    }
    for (const number of [801, 802, 803, 804]) assert.ok(requests.includes(number))
    for (const number of [802, 803, 804]) {
      assert.equal(requests.filter((requested) => requested === number).length, 1)
    }
  })

  it('shows known conflicts as an X while retaining the failing CI label', async () => {
    const { listRoot } = mount([], {
      linkedUrls: 'https://github.com/acme/widgets/pull/994',
      prDetails: async (owner, repo, number) =>
        number === 994
          ? {
              owner,
              repo,
              number,
              title: 'Resolve merge conflicts',
              url: `https://github.com/${owner}/${repo}/pull/${String(number)}`,
              state: 'OPEN',
              mergeStateStatus: 'DIRTY',
              body: '',
              files: [],
            }
          : null,
      prChecks: async () => 'failure',
    })
    await settle()
    await new Promise((resolve) => setTimeout(resolve, 10))
    const status = listRoot.querySelector('.pr-list-row[data-pr-section="linked"] .pr-list-status')
    assert.ok(status)
    assert.equal(status.classList.contains('has-conflicts'), true)
    assert.equal(status.classList.contains('has-ci-failure'), false)
    assert.match(status.getAttribute('aria-label') ?? '', /merge conflicts; CI failing/)
    assert.equal(
      status.querySelector('svg path:nth-child(2)')?.getAttribute('d'),
      'M3 3l6 6m0-6L3 9',
    )
  })

  it('uses thread status glyphs for lifecycle states and resolves failing checks in place', async () => {
    let resolveChecks: (state: 'failure') => void = () => {}
    const { listRoot } = mount(
      [
        { ...OTHER_PR, number: 991, state: 'MERGED', checks: 'failure' },
        { ...OTHER_PR, number: 992, state: 'CLOSED', checks: 'failure' },
      ],
      {
        prChecks: () =>
          new Promise((resolve) => {
            resolveChecks = resolve
          }),
      },
    )
    await settle()
    const open = listRoot.querySelector('.pr-list-status.is-open')
    assert.ok(open)
    assert.ok(open.querySelector('svg[data-icon="git-pull-request"]'))
    assert.equal(open.classList.contains('has-ci-failure'), false)
    resolveChecks('failure')
    await settle()
    assert.ok(listRoot.querySelector('.pr-list-status.is-open.has-ci-failure'))
    listRoot.querySelector<HTMLButtonElement>('.pr-other-toggle')?.click()
    await settle()
    const merged = listRoot.querySelector('.pr-list-status.is-merged')
    const closed = listRoot.querySelector('.pr-list-status.is-closed')
    assert.ok(merged)
    assert.ok(closed)
    assert.ok(merged.querySelector('svg[data-icon="git-merge"]'))
    assert.ok(closed.querySelector('svg[data-icon="git-pull-request"]'))
    assert.equal(merged.classList.contains('has-ci-failure'), false)
    assert.equal(closed.classList.contains('has-ci-failure'), false)
    assert.match(merged.getAttribute('aria-label') ?? '', /merged; CI failing/)
    assert.equal(listRoot.querySelector('.pr-list-ci'), null)
  })

  it('learns merged lifecycle from details for a chat-linked PR absent from open listings', async () => {
    const { listRoot } = mount([], {
      linkedUrls: 'https://github.com/acme/widgets/pull/993',
      prDetails: async (owner, repo, number) =>
        number === 993
          ? {
              owner,
              repo,
              number,
              title: 'Already shipped',
              url: `https://github.com/${owner}/${repo}/pull/${String(number)}`,
              state: 'MERGED',
              body: '',
              files: [],
            }
          : null,
    })
    await settle()
    await new Promise((resolve) => setTimeout(resolve, 10))
    const linked = listRoot.querySelector('.pr-list-row[data-pr-section="linked"]')
    assert.ok(linked)
    assert.ok(linked.querySelector('.pr-list-status.is-merged svg[data-icon="git-merge"]'))
    assert.match(linked.textContent, /Already shipped/)
  })

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
