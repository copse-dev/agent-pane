import '../../../tests/setup-dom.ts'
import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type * as Monaco from 'monaco-editor'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GitStatusResult } from '@shared/types/git.ts'
import { mountGitChangesPane } from './git-changes-pane.ts'

// Regression for #459 ("Changeset viewer doesn't render the diff currently").
//
// Making Monaco load asynchronously (#378) moved mountGitChangesPane behind
// `loadMonaco().then(...)`, so it now mounts a turn *after* the layout. The
// right panel is normally already in "changes" mode by then, so the
// `right_panel_mode_changed` event that used to trigger the first refresh has
// already fired before this pane subscribed — and the diff never rendered.
//
// The fix has the pane catch up to the current state on mount: when changes
// mode is already active, it refreshes itself. This test mounts the pane with
// the mode already active and asserts the initial git status fetch happens with
// no store event being emitted afterwards. It runs in happy-dom against the
// real view; Monaco is only touched once a diff actually renders, so a bare
// stub is enough here.

const emptyStatus: GitStatusResult = { staged: [], unstaged: [] }

function makeApi(calls: { isAvailable: number; status: number }): ApiClient {
  const noopUnsub = (): (() => void) => () => {}
  return {
    git: {
      isAvailable: async () => {
        calls.isAvailable++
        return true
      },
      status: async () => {
        calls.status++
        return emptyStatus
      },
      fileDiff: async () => null,
    },
    diff: {
      approve: async () => {},
      reject: async () => {},
      approveAll: async () => {},
      rejectAll: async () => {},
      onShowDiff: noopUnsub(),
      onQueued: noopUnsub(),
      onConflict: noopUnsub(),
    },
    fs: {
      onChanged: noopUnsub(),
    },
  } as unknown as ApiClient
}

const monacoStub = {} as unknown as typeof Monaco

// observeDiffHostLayout / whenDiffHostVisible construct ResizeObserver at mount,
// which happy-dom doesn't expose as a global; a noop is enough for these
// store-driven assertions. Mirrors browser-pane.test.ts.
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

describe('git changes pane catches up on async mount (#459)', () => {
  it('refreshes itself when mounted with changes mode already active', async () => {
    const store = createStore({
      filesPaneOpen: true,
      rightPanelMode: 'changes',
    })
    const calls = { isAvailable: 0, status: 0 }
    const api = makeApi(calls)

    const listRoot = document.createElement('div')
    const viewerRoot = document.createElement('div')
    document.body.append(listRoot, viewerRoot)

    // Mounting alone — without emitting any store event — must kick off the
    // initial refresh, because the deferred (async) mount missed the original
    // right_panel_mode_changed event.
    mountGitChangesPane(listRoot, viewerRoot, store, api, monacoStub)

    // refresh() awaits isAvailable() then status(); let those microtasks settle.
    await Promise.resolve()
    await Promise.resolve()

    assert.equal(calls.isAvailable, 1, 'should probe git availability on mount')
    assert.equal(calls.status, 1, 'should fetch git status on mount')
  })

  it('does not refresh when changes mode is not active on mount', async () => {
    const store = createStore({
      filesPaneOpen: false,
      rightPanelMode: 'explorer',
    })
    const calls = { isAvailable: 0, status: 0 }
    const api = makeApi(calls)

    const listRoot = document.createElement('div')
    const viewerRoot = document.createElement('div')
    document.body.append(listRoot, viewerRoot)

    mountGitChangesPane(listRoot, viewerRoot, store, api, monacoStub)

    await Promise.resolve()
    await Promise.resolve()

    assert.equal(calls.isAvailable, 0, 'should not probe git when changes mode is inactive')
    assert.equal(calls.status, 0, 'should not fetch status when changes mode is inactive')
  })
})
