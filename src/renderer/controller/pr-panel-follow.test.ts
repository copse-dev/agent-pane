import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { AppState } from '@shared/types/state.ts'
import type { GithubPrRef } from '@shared/git/github-pr-url.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { attachPrPanelFollow } from './pr-panel-follow.ts'

const REF: GithubPrRef = {
  owner: 'copse-dev',
  repo: 'agent-pane',
  number: 7,
  url: 'https://github.com/copse-dev/agent-pane/pull/7',
}

/** Fake api that hands the test the `onPrCreated` handler to fire by hand. */
function apiWithPrCreated(): {
  api: ApiClient
  announce: (projectId: string, threadId: string, ref: GithubPrRef) => void
  unsubscribed: () => boolean
} {
  const api = createFakeApi()
  let handler: ((projectId: string, threadId: string, ref: GithubPrRef) => void) | null = null
  let off = false
  const threads = {
    ...api.threads,
    onPrCreated: (next: (projectId: string, threadId: string, ref: GithubPrRef) => void) => {
      handler = next
      return (): void => {
        off = true
      }
    },
  }
  return {
    api: { ...api, threads },
    announce: (projectId, threadId, ref) => handler?.(projectId, threadId, ref),
    unsubscribed: () => off,
  }
}

function storeOnChanges(overrides: Partial<AppState> = {}): AppStore {
  return createStore({
    activeProjectId: 'p',
    activeThreadId: 't1',
    filesPaneOpen: true,
    rightPanelMode: 'changes',
    ...overrides,
  })
}

test('switches the Changes panel to the PR the active thread just opened', () => {
  const store = storeOnChanges()
  const { api, announce } = apiWithPrCreated()
  const requested: Array<[string, string, number]> = []
  store.on('pr_open_requested', (owner, repo, number) => requested.push([owner, repo, number]))
  const detach = attachPrPanelFollow(store, api)

  announce('p', 't1', REF)

  assert.equal(store.getState().rightPanelMode, 'prs')
  assert.equal(store.getState().filesPaneOpen, true)
  assert.deepEqual(requested, [['copse-dev', 'agent-pane', 7]])
  detach()
})

test('leaves any other pane alone', () => {
  const store = storeOnChanges({ rightPanelMode: 'terminal' })
  const { api, announce } = apiWithPrCreated()
  const detach = attachPrPanelFollow(store, api)

  announce('p', 't1', REF)

  assert.equal(store.getState().rightPanelMode, 'terminal')
  detach()
})

test('does not reopen a closed panel', () => {
  const store = storeOnChanges({ filesPaneOpen: false })
  const { api, announce } = apiWithPrCreated()
  const detach = attachPrPanelFollow(store, api)

  announce('p', 't1', REF)

  assert.equal(store.getState().filesPaneOpen, false)
  assert.equal(store.getState().rightPanelMode, 'changes')
  detach()
})

test('ignores a PR opened by a background thread or another project', () => {
  const store = storeOnChanges()
  const { api, announce } = apiWithPrCreated()
  const detach = attachPrPanelFollow(store, api)

  announce('p', 't2', REF)
  assert.equal(store.getState().rightPanelMode, 'changes')

  announce('other', 't1', REF)
  assert.equal(store.getState().rightPanelMode, 'changes')
  detach()
})

test('detaching unsubscribes', () => {
  const store = storeOnChanges()
  const { api, unsubscribed } = apiWithPrCreated()

  attachPrPanelFollow(store, api)()

  assert.equal(unsubscribed(), true)
})
