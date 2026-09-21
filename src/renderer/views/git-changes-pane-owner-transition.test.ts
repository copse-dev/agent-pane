import '../../../tests/setup-dom.ts'
import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { switchThread } from '@shared/store/thread-helpers.ts'
import type { Thread } from '@shared/types'
import type { ActiveDiff } from '@shared/types/state.ts'
import type { GitStatusResult } from '@shared/types/git.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountGitChangesPane } from './git-changes-pane.ts'

const EMPTY_STATUS: GitStatusResult = { staged: [], unstaged: [] }

function thread(id: string): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function imageDiff(after: string): ActiveDiff {
  return {
    path: 'same.png',
    before: 'before-image',
    after,
    language: 'plaintext',
  }
}

function makeApi(current: { value: ActiveDiff }, contentCalls: string[]): ApiClient {
  const noopUnsub = (): (() => void) => () => {}
  const base = createFakeApi()
  return {
    ...base,
    git: {
      ...base.git,
      isAvailable: async () => true,
      status: async () => EMPTY_STATUS,
      committedChanges: async () => null,
      sessionBackup: async () => null,
      fileDiff: async () => null,
    },
    diff: {
      ...base.diff,
      content: async (_projectId, _threadId, path): Promise<ActiveDiff | null> => {
        contentCalls.push(path)
        return path === current.value.path ? current.value : null
      },
      onShowDiff: noopUnsub,
      onQueued: noopUnsub,
      onConflict: noopUnsub,
    },
    fs: {
      ...base.fs,
      onChanged: noopUnsub,
    },
  }
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

describe('Changes pane owner transitions', () => {
  it('production thread switching clears the proposed queue before panel_changed', () => {
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'a',
      threads: [thread('a'), thread('b')],
      stagedDiffs: [{ path: 'a.png', language: 'plaintext' }],
      activeDiff: imageDiff('a-after'),
    })
    const panelStates: Array<{
      activeThreadId: string | null
      stagedPaths: string[]
      activeDiff: ActiveDiff | null
    }> = []
    store.on('panel_changed', () => {
      const state = store.getState()
      panelStates.push({
        activeThreadId: state.activeThreadId,
        stagedPaths: state.stagedDiffs.map((entry) => entry.path),
        activeDiff: state.activeDiff,
      })
    })

    switchThread(store, 'b')

    assert.deepEqual(panelStates, [
      {
        activeThreadId: 'b',
        stagedPaths: [],
        activeDiff: null,
      },
    ])
  })

  it('refreshes proposed content after the same thread receives a new worktree', async () => {
    const current = { value: imageDiff('old-after') }
    const contentCalls: string[] = []
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'a',
      threads: [thread('a')],
      filesPaneOpen: true,
      rightPanelMode: 'changes',
      stagedDiffs: [{ path: 'same.png', language: 'plaintext' }],
    })
    const listRoot = document.createElement('div')
    const viewerRoot = document.createElement('div')
    document.body.append(listRoot, viewerRoot)

    mountGitChangesPane(listRoot, viewerRoot, store, makeApi(current, contentCalls), null)
    await settle()
    assert.deepEqual(contentCalls, ['same.png'])
    assert.match(
      viewerRoot.querySelectorAll<HTMLImageElement>('.git-image-diff-img')[1]?.src ?? '',
      /b2xkLWFmdGVy/,
    )

    current.value = imageDiff('new-after')
    store.setState({
      threads: [
        {
          ...thread('a'),
          worktree: {
            path: '/isolated/a',
            branch: 'feature/a',
            baseBranch: 'main',
            baseCommit: 'abc',
            createdAt: 2,
            seededFromDirtyProject: false,
          },
        },
      ],
    })
    store.emit('threads_changed')
    await settle()

    assert.deepEqual(
      contentCalls,
      ['same.png', 'same.png'],
      'a changed worktree must fetch current proposed content instead of reusing the old owner cache',
    )
    assert.match(
      viewerRoot.querySelectorAll<HTMLImageElement>('.git-image-diff-img')[1]?.src ?? '',
      /bmV3LWFmdGVy/,
    )
  })
})
