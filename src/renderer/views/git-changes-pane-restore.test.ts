import '../../../tests/setup-dom.ts'
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type * as Monaco from 'monaco-editor'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GitStatusResult, SessionBackup } from '@shared/types/git.ts'
import {
  clickActiveConfirmDialogCancel,
  clickActiveConfirmDialogConfirm,
  mountConfirmDialog,
} from './confirm-dialog.ts'
import { mountGitChangesPane } from './git-changes-pane.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// Coverage for the "Restore pre-session changes" affordance (#699): when Copse
// auto-applied edits over the user's uncommitted work this session, the changes
// pane surfaces the session backup and lets the user one-click revert it.

const emptyStatus: GitStatusResult = { staged: [], unstaged: [] }
const monacoStub = {} as unknown as typeof Monaco

function makeApi(opts: {
  sessionBackup: SessionBackup | null
  restore?: () => Promise<boolean>
  restoreCalls?: { count: number }
}): ApiClient {
  const noopUnsub = (): (() => void) => () => {}
  return ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      git: {
        ...base['git'],
        isAvailable: async () => true,
        status: async () => emptyStatus,
        fileDiff: async () => null,
        sessionBackup: async () => opts.sessionBackup,
        restoreBackup: async (): Promise<boolean> => {
          if (opts.restoreCalls) opts.restoreCalls.count++
          return opts.restore ? opts.restore() : true
        },
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
    } satisfies ApiClient
  })()
}

beforeEach(() => {
  mountConfirmDialog()
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

function mount(api: ApiClient): HTMLElement {
  const store = createStore({
    activeProjectId: 'project-1',
    activeThreadId: 'thread-1',
    filesPaneOpen: true,
    rightPanelMode: 'changes',
  })
  const listRoot = document.createElement('div')
  const viewerRoot = document.createElement('div')
  document.body.append(listRoot, viewerRoot)
  mountGitChangesPane(listRoot, viewerRoot, store, api, monacoStub)
  return listRoot
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

describe('git changes pane restore affordance (#699)', () => {
  it('hides the restore banner when there is no session backup', async () => {
    const listRoot = mount(makeApi({ sessionBackup: null }))
    await settle()
    const banner = listRoot.querySelector<HTMLElement>('.git-changes-restore')
    assert.ok(banner, 'banner element should exist')
    assert.equal(banner.hidden, true, 'banner should be hidden with no backup')
  })

  it('shows the banner with a file count when a session backup exists', async () => {
    const listRoot = mount(
      makeApi({
        sessionBackup: { ref: 'refs/copse/backups/1', createdAt: 1, paths: ['a.ts', 'b.ts'] },
      }),
    )
    await settle()
    const banner = listRoot.querySelector<HTMLElement>('.git-changes-restore')
    assert.ok(banner)
    assert.equal(banner.hidden, false, 'banner should be visible when a backup exists')
    const label = listRoot.querySelector('.git-changes-restore-label')?.textContent ?? ''
    assert.match(label, /2 files/, 'label should reflect the captured file count')
  })

  it('restores on click after confirmation and re-refreshes', async () => {
    const restoreCalls = { count: 0 }
    const listRoot = mount(
      makeApi({
        sessionBackup: { ref: 'refs/copse/backups/1', createdAt: 1, paths: ['a.ts'] },
        restoreCalls,
      }),
    )
    await settle()
    const btn = listRoot.querySelector<HTMLButtonElement>('.git-changes-restore-btn')
    assert.ok(btn)
    btn.click()
    await settle()
    clickActiveConfirmDialogConfirm()
    await settle()
    assert.equal(restoreCalls.count, 1, 'restore should be invoked once')
  })

  it('does not restore when the user cancels the confirmation', async () => {
    const restoreCalls = { count: 0 }
    const listRoot = mount(
      makeApi({
        sessionBackup: { ref: 'refs/copse/backups/1', createdAt: 1, paths: ['a.ts'] },
        restoreCalls,
      }),
    )
    await settle()
    listRoot.querySelector<HTMLButtonElement>('.git-changes-restore-btn')?.click()
    await settle()
    clickActiveConfirmDialogCancel()
    await settle()
    assert.equal(restoreCalls.count, 0, 'restore must not run when cancelled')
  })
})
