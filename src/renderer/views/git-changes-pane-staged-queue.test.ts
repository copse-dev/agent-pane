import '../../../tests/setup-dom.ts'
import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { StagedDiffEntry } from '@shared/types/state.ts'
import { mountGitChangesPane } from './git-changes-pane.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// The Changes pane follows the proposed-diff queue in the store. A writer only
// has to `setState({ stagedDiffs })`; there is no separate event to remember.

type ConflictListener = (projectId: string, threadId: string, paths: string[]) => void

function makeApi(conflict: { listener: ConflictListener | null }): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    diff: {
      ...base.diff,
      onConflict: (listener) => {
        conflict.listener = listener
        return () => {}
      },
    },
    git: {
      ...base.git,
      isAvailable: async () => true,
      status: async () => ({ staged: [], unstaged: [] }),
      committedChanges: async () => null,
    },
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function proposedTitle(listRoot: HTMLElement): string | null {
  return (
    listRoot.querySelector('.git-changes-section-proposed .git-changes-section-title')
      ?.textContent ?? null
  )
}

const QUEUE: StagedDiffEntry[] = [
  { path: 'a.ts', language: 'typescript' },
  { path: 'b.ts', language: 'typescript' },
]

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

describe('git changes pane: staged queue', () => {
  for (const mode of ['changes', 'browser'] as const) {
    it(`repaints the Proposed section from setState alone (${mode} panel)`, async () => {
      const store = createStore({
        activeProjectId: 'project-1',
        activeThreadId: 'thread-1',
        filesPaneOpen: true,
        rightPanelMode: mode,
      })
      const listRoot = document.createElement('div')
      const viewerRoot = document.createElement('div')
      document.body.append(listRoot, viewerRoot)
      const unmount = mountGitChangesPane(
        listRoot,
        viewerRoot,
        store,
        makeApi({ listener: null }),
        null,
      )
      await settle()
      assert.equal(proposedTitle(listRoot), null)

      store.setState({ stagedDiffs: QUEUE })
      await settle()
      assert.equal(proposedTitle(listRoot), 'Proposed (2)')

      store.setState({ stagedDiffs: [] })
      await settle()
      assert.equal(proposedTitle(listRoot), null)
      unmount()
    })
  }

  it('hides the conflict banner once the queue empties', async () => {
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      filesPaneOpen: true,
      rightPanelMode: 'changes',
      stagedDiffs: QUEUE,
    })
    const conflict: { listener: ConflictListener | null } = { listener: null }
    const listRoot = document.createElement('div')
    const viewerRoot = document.createElement('div')
    document.body.append(listRoot, viewerRoot)
    const unmount = mountGitChangesPane(listRoot, viewerRoot, store, makeApi(conflict), null)
    await settle()

    conflict.listener?.('project-1', 'thread-1', ['a.ts'])
    const banner = viewerRoot.querySelector<HTMLElement>('.diff-conflict-banner')
    assert.ok(banner)
    assert.equal(banner.hidden, false)

    store.setState({ stagedDiffs: [] })
    assert.equal(banner.hidden, true)
    unmount()
  })
})
