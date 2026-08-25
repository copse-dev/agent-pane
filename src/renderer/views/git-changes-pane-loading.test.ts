import '../../../tests/setup-dom.ts'
import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GitStatusResult } from '@shared/types/git.ts'
import { mountGitChangesPane } from './git-changes-pane.ts'
import { createFakeApi, createPendingApi } from '../fake-api.test-support.ts'

// The Changes pane mounts behind the Monaco bundle and then asks the main
// process three questions (is this a repo, what changed, what was committed).
// It used to render its settled answers — "Not a git repository", then "No
// changes" — through that whole window, which reads exactly like the truth. A
// user watching the pane on a cold start was told their repo wasn't one.

const CLEAN: GitStatusResult = { staged: [], unstaged: [] }

const noopUnsub = (): (() => void) => () => {}

/** Event subscriptions must hand back real unsubscribers, promises won't do. */
const SUBSCRIPTIONS = {
  'diff.onShowDiff': noopUnsub,
  'diff.onConflict': noopUnsub,
  'diff.onQueued': noopUnsub,
  'fs.onChanged': noopUnsub,
  'git.onWorkingTreeChanged': noopUnsub,
}

function mount(api: ApiClient): { listRoot: HTMLElement; viewerRoot: HTMLElement } {
  const store = createStore({
    activeProjectId: 'project-1',
    activeThreadId: 'thread-1',
    filesPaneOpen: true,
    rightPanelMode: 'changes',
  })
  const listRoot = document.createElement('div')
  const viewerRoot = document.createElement('div')
  document.body.append(listRoot, viewerRoot)
  mountGitChangesPane(listRoot, viewerRoot, store, api, null)
  return { listRoot, viewerRoot }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function listText(listRoot: HTMLElement): string {
  return listRoot.querySelector('.git-changes-empty')?.textContent ?? ''
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

describe('git changes pane loading state', () => {
  it('shows a loading row, not "Not a git repository", while the probe is in flight', async () => {
    const { listRoot, viewerRoot } = mount(createPendingApi(SUBSCRIPTIONS))
    await settle()

    assert.equal(listRoot.querySelectorAll('.pane-loading').length, 1)
    assert.match(listText(listRoot), /Loading changes/)
    assert.equal(viewerRoot.querySelector('.panel-empty')?.textContent, 'Loading changes…')
  })

  it('keeps loading after the repo probe answers but before the status lands', async () => {
    const { listRoot } = mount(
      createPendingApi({ ...SUBSCRIPTIONS, 'git.isAvailable': async () => true }),
    )
    await settle()

    assert.match(listText(listRoot), /Loading changes/)
    assert.notEqual(listText(listRoot), 'No changes')
  })

  it('settles to "No changes" once a clean repo has answered', async () => {
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      git: {
        ...base['git'],
        isAvailable: async () => true,
        status: async () => CLEAN,
        committedChanges: async () => null,
        sessionBackup: async () => null,
      },
    }
    const { listRoot, viewerRoot } = mount(api)
    await settle()

    assert.equal(listRoot.querySelector('.pane-loading'), null)
    assert.equal(listText(listRoot), 'No changes')
    assert.equal(viewerRoot.querySelector('.panel-empty')?.textContent, 'Select a changed file')
  })

  it('settles to "Not a git repository" once the probe says so', async () => {
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      git: { ...base['git'], isAvailable: async () => false },
    }
    const { listRoot } = mount(api)
    await settle()

    assert.equal(listRoot.querySelector('.pane-loading'), null)
    assert.equal(listText(listRoot), 'Not a git repository')
  })

  it('stays in the loading state while no thread is active yet', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'changes' })
    const listRoot = document.createElement('div')
    const viewerRoot = document.createElement('div')
    document.body.append(listRoot, viewerRoot)
    mountGitChangesPane(listRoot, viewerRoot, store, createPendingApi(SUBSCRIPTIONS), null)
    await settle()

    // Launch hasn't hydrated a thread yet — that is "not known", not "no repo".
    assert.match(listText(listRoot), /Loading changes/)
  })
})
