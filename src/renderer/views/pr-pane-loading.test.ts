import '../../../tests/setup-dom.ts'
import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GhCliStatus } from '@shared/types/git.ts'
import { mountPrPane } from './pr-pane.ts'
import { createFakeApi, createPendingApi } from '../fake-api.test-support.ts'
import type { GitDiffMonaco } from '../monaco/git-diff-viewer.ts'

// `gh.status()` is an IPC round-trip that shells out, so the pane paints well
// before it answers. Reading that unanswered null as "gh is missing" told users
// with a working, authenticated CLI to go install one.

const noopUnsub = (): (() => void) => () => {}

function unreachableMonacoCall(): never {
  throw new Error('loading-state tests must not create a Monaco diff editor')
}

// The pane only touches setTheme on this list-only path. Satisfy the deliberately
// narrow GitDiffMonaco boundary so an accidental diff render fails loudly.
const MONACO_STUB: GitDiffMonaco = {
  KeyCode: { KeyL: 0 },
  Uri: { parse: (value) => ({ toString: () => value }) },
  editor: {
    createDiffEditor: unreachableMonacoCall,
    createModel: unreachableMonacoCall,
    setTheme: (): void => {},
  },
}

function mount(api: ApiClient): { listRoot: HTMLElement; viewerRoot: HTMLElement } {
  const store = createStore({
    activeProjectId: 'project-1',
    activeThreadId: 'thread-1',
    filesPaneOpen: true,
    rightPanelMode: 'prs',
  })
  const listRoot = document.createElement('div')
  const viewerRoot = document.createElement('div')
  document.body.append(listRoot, viewerRoot)
  mountPrPane(listRoot, viewerRoot, store, api, MONACO_STUB)
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

describe('pr pane loading state', () => {
  it('shows a loading row instead of the "install gh" copy while status is in flight', async () => {
    const { listRoot } = mount(createPendingApi({ 'gh.onListsTick': noopUnsub }))
    await settle()

    assert.equal(listRoot.querySelectorAll('.pane-loading').length, 1)
    assert.match(listText(listRoot), /Loading pull requests/)
    assert.doesNotMatch(listText(listRoot), /Install GitHub CLI/)
  })

  it('settles to the "install gh" copy once status says the CLI is missing', async () => {
    const missing: GhCliStatus = {
      installed: false,
      authenticated: false,
      username: null,
      message: null,
    }
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      gh: {
        ...base['gh'],
        status: async () => missing,
        agentPrLinks: async () => [],
        onListsTick: noopUnsub,
      },
    }
    const { listRoot } = mount(api)
    await settle()

    assert.equal(listRoot.querySelector('.pane-loading'), null)
    assert.match(listText(listRoot), /Install GitHub CLI/)
  })
})
