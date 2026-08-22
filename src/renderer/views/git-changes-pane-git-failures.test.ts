import '../../../tests/setup-dom.ts'
import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GitStatusResult } from '@shared/types/git.ts'
import { mountGitChangesPane } from './git-changes-pane.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// Regression for #1880: a failing git IPC read used to reject out of the pane's
// refresh timers and selection handlers, so one bad thread state — a worktree
// failing validation, or a thread queried before its store record persisted —
// produced an "Uncaught (in promise)" plus an error toast on every refresh
// tick.
//
// The pane now treats a failed read as "git unavailable": it logs a warning,
// renders the same empty list as a non-repository, and keeps polling so it
// recovers by itself once main answers again. These tests run in happy-dom
// against the real view; Monaco is only touched once a diff renders.

const emptyStatus: GitStatusResult = { staged: [], unstaged: [] }

interface ProbeScript {
  /** Per-call outcomes for isAvailable: `false` = answer false, `'throw'` = reject. */
  availability: Array<boolean | 'throw'>
  /** When set, every status read rejects after isAvailable answered true. */
  failStatusWith?: Error
}

function mountPane(script: ProbeScript): {
  listRoot: HTMLElement
  store: AppStore
  dispose: () => void
} {
  const store = createStore({
    activeProjectId: 'project-1',
    activeThreadId: 'thread-1',
    filesPaneOpen: true,
    rightPanelMode: 'changes',
  })
  const noopUnsub = (): (() => void) => () => {}
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    git: {
      ...base['git'],
      isAvailable: async (): Promise<boolean> => {
        const outcome = script.availability.shift() ?? true
        if (outcome === 'throw') {
          throw new Error('Thread worktree branch must differ from its recorded base branch')
        }
        return outcome
      },
      status: async (): Promise<GitStatusResult | null> => {
        if (script.failStatusWith) throw script.failStatusWith
        return emptyStatus
      },
      committedChanges: async () => ({ changes: [], baseLabel: 'main' }),
      sessionBackup: async () => null,
      fileDiff: async () => null,
      onWorkingTreeChanged: noopUnsub,
    },
    diff: {
      ...base['diff'],
      approve: async (): Promise<void> => {},
      reject: async (): Promise<void> => {},
      approveAll: async (): Promise<void> => {},
      rejectAll: async (): Promise<void> => {},
      onShowDiff: noopUnsub,
      onQueued: noopUnsub,
      onConflict: noopUnsub,
    },
    fs: {
      ...base['fs'],
      onChanged: noopUnsub,
    },
  }

  const listRoot = document.createElement('div')
  const viewerRoot = document.createElement('div')
  document.body.append(listRoot, viewerRoot)
  const dispose = mountGitChangesPane(listRoot, viewerRoot, store, api, null)
  return { listRoot, store, dispose }
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

function emptyMessage(listRoot: HTMLElement): string | null {
  return listRoot.querySelector<HTMLElement>('.git-changes-empty')?.textContent ?? null
}

describe('git changes pane survives failing git IPC reads (#1880)', () => {
  it('renders the unavailable state instead of rejecting when isAvailable throws', async () => {
    const { listRoot, dispose } = mountPane({ availability: ['throw'] })

    // refresh() awaits isAvailable() then renders; let those microtasks settle.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    assert.equal(emptyMessage(listRoot), 'Not a git repository')

    dispose()
  })

  it('recovers on the next refresh once git answers again', async () => {
    const { listRoot, store, dispose } = mountPane({ availability: ['throw', true] })

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(emptyMessage(listRoot), 'Not a git repository')

    // The next refresh arrives with the pane's event-driven path (the same one
    // fs/working-tree changes use); the debounced timer only re-probes while
    // events keep coming.
    store.emit('right_panel_mode_changed')
    // The refresh chain awaits four IPC calls; flush with a macrotask rather
    // than counting microtask ticks.
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    await Promise.resolve()
    await Promise.resolve()

    assert.equal(emptyMessage(listRoot), 'No changes')

    dispose()
  })

  it('clears to the unavailable state instead of rejecting when status reads throw', async () => {
    const { listRoot, dispose } = mountPane({
      availability: [true],
      failStatusWith: new Error('Thread "thread-1" is not persisted yet under project "project-1"'),
    })

    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    await Promise.resolve()
    await Promise.resolve()

    assert.equal(emptyMessage(listRoot), 'Not a git repository')

    dispose()
  })
})
