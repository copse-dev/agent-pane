import '../../../tests/setup-dom.ts'
import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GitStatusResult } from '@shared/types/git.ts'
import type { ActiveDiff, StagedDiffEntry } from '@shared/types/state.ts'
import { mountGitChangesPane } from './git-changes-pane.ts'
import { applyPopoutSeed, capturePopoutSeed } from '../popout/pane-popout-seed.ts'
import { attachDiffState } from '../controller/diff-state.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import type { GitDiffEditor, GitDiffMonaco } from '../monaco/git-diff-viewer.ts'

// #1704. A pane pop-out loads the same renderer with `?popout=changes` in a
// second window. The main process pushed the diff queue to the main window only,
// and `main.ts` skips the agent controller in pop-out mode, so the detached
// Changes pane had `stagedDiffs: []` forever and rendered no "Proposed" section
// — while the main window, side by side with it, showed one.

const emptyStatus: GitStatusResult = { staged: [], unstaged: [] }

interface Counters {
  createModel: number
  setModel: number
}

function makeMonacoStub(counters: Counters): GitDiffMonaco {
  const noopEditor = {
    onKeyDown: (): { dispose(): void } => ({ dispose(): void {} }),
    getModel: (): null => null,
    getSelection: (): null => null,
    revealLineInCenterIfOutsideViewport: (): void => {},
  }
  return {
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    editor: {
      createDiffEditor: (): GitDiffEditor => {
        let models: ReturnType<GitDiffEditor['getModel']> = null
        const self: GitDiffEditor = {
          getOriginalEditor: () => noopEditor,
          getModifiedEditor: () => noopEditor,
          onDidUpdateDiff: () => ({ dispose(): void {} }),
          getModel: () => models,
          setModel: (next) => {
            counters.setModel++
            models = next && 'model' in next ? (next.model ?? null) : null
          },
          createViewModel: (model) => ({
            model,
            waitForDiff: async (): Promise<void> => {},
            dispose: (): void => {},
          }),
          updateOptions: (): void => {},
          layout: (): void => {},
          getLineChanges: () => [
            {
              originalStartLineNumber: 1,
              originalEndLineNumber: 1,
              modifiedStartLineNumber: 1,
              modifiedEndLineNumber: 1,
            },
          ],
          dispose: (): void => {},
        }
        return self
      },
      createModel: (value: string): { dispose(): void; getValue(): string } => {
        counters.createModel++
        return { dispose(): void {}, getValue: () => value }
      },
      setTheme(): void {},
    },
    KeyCode: { KeyL: 42 },
  }
}

type FsChangedHandler = (
  projectId: string,
  threadId: string,
  path: string,
  content: string | null,
) => void

interface ApiHarness {
  api: ApiClient
  contentCalls: string[]
  fireFsChanged: () => void
}

function makeApi(staged: Record<string, ActiveDiff>): ApiHarness {
  const noopUnsub = (): (() => void) => () => {}
  const fsHandlers: FsChangedHandler[] = []
  const contentCalls: string[] = []
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    git: {
      ...base['git'],
      isAvailable: async () => true,
      status: async () => emptyStatus,
      fileDiff: async () => null,
      sessionBackup: async () => null,
    },
    diff: {
      ...base['diff'],
      content: async (_p: string, _t: string, path: string): Promise<ActiveDiff | null> => {
        contentCalls.push(path)
        return staged[path] ?? null
      },
      queue: async (): Promise<StagedDiffEntry[]> =>
        Object.values(staged).map((d) => ({ path: d.path, language: d.language })),
      onShowDiff: noopUnsub,
      onQueued: noopUnsub,
      onConflict: noopUnsub,
    },
    fs: {
      ...base['fs'],
      onChanged: (handler: FsChangedHandler): (() => void) => {
        fsHandlers.push(handler)
        return () => {}
      },
    },
  }
  return {
    api,
    contentCalls,
    fireFsChanged: (): void => {
      for (const handler of fsHandlers) handler('project-1', 'thread-1', 'watched.ts', null)
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

async function settle(ms = 0): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

function mountHosts(): { listRoot: HTMLElement; viewerRoot: HTMLElement } {
  const listRoot = document.createElement('div')
  const viewerRoot = document.createElement('div')
  // whenDiffHostVisible gates on a real layout box; happy-dom reports 0.
  Object.defineProperty(viewerRoot, 'offsetWidth', { configurable: true, value: 100 })
  Object.defineProperty(viewerRoot, 'offsetHeight', { configurable: true, value: 100 })
  document.body.append(listRoot, viewerRoot)
  return { listRoot, viewerRoot }
}

const PROPOSED: Record<string, ActiveDiff> = {
  'x.ts': { path: 'x.ts', before: 'old\n', after: 'new\n', language: 'typescript' },
}

describe('#1704 Changes in a pop-out window', () => {
  it('renders the Proposed section from a hydrated queue, with no push received', async () => {
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      filesPaneOpen: true,
      rightPanelMode: 'changes',
    })
    const { api } = makeApi(PROPOSED)
    const { listRoot, viewerRoot } = mountHosts()

    // A pop-out runs the diff-state wiring alone; no `diff:queued` ever arrives.
    attachDiffState(store, api, { revealOnShowDiff: false })
    mountGitChangesPane(
      listRoot,
      viewerRoot,
      store,
      api,
      makeMonacoStub({
        createModel: 0,
        setModel: 0,
      }),
    )
    await settle()

    const proposedRows = listRoot.querySelectorAll('.git-change-row-proposed')
    assert.equal(proposedRows.length, 1, 'the detached pane lists the proposed file')
    assert.match(
      listRoot.querySelector('.git-changes-section-proposed')?.textContent ?? '',
      /Proposed \(1\)/,
    )
  })

  it('shows the seeded proposed diff instead of falling through to a git file', async () => {
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      filesPaneOpen: true,
      rightPanelMode: 'changes',
    })
    // The pop-out seed replays the parent window's selection, and can land
    // before this window's own queue has hydrated — note `attachDiffState` is
    // deliberately not started here, so `stagedDiffs` stays empty for the whole
    // test. The content fetch must not be gated on the path already being
    // queued, and the seeded selection must survive the first refresh.
    const { api, contentCalls } = makeApi(PROPOSED)
    const { listRoot, viewerRoot } = mountHosts()
    mountGitChangesPane(
      listRoot,
      viewerRoot,
      store,
      api,
      makeMonacoStub({
        createModel: 0,
        setModel: 0,
      }),
    )

    await applyPopoutSeed('changes', { kind: 'proposed', path: 'x.ts' }, store)
    await settle()

    assert.deepEqual(contentCalls, ['x.ts'], 'pulls the content the main process still holds')
    const acceptBtn = viewerRoot.querySelector<HTMLElement>('.diff-accept-btn')
    assert.equal(acceptBtn?.hidden, false, 'Accept is reachable from the pop-out')
  })

  it('round-trips a proposed selection through capture/apply', async () => {
    const parent = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      filesPaneOpen: true,
      rightPanelMode: 'changes',
    })
    parent.setState({ stagedDiffs: [{ path: 'x.ts', language: 'typescript' }] })
    const { api } = makeApi(PROPOSED)
    const hosts = mountHosts()
    const unmount = mountGitChangesPane(
      hosts.listRoot,
      hosts.viewerRoot,
      parent,
      api,
      makeMonacoStub({ createModel: 0, setModel: 0 }),
    )
    await settle()

    const seed = capturePopoutSeed('changes', parent)
    unmount()
    document.body.replaceChildren()

    const popout = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      filesPaneOpen: true,
      rightPanelMode: 'changes',
    })
    const popHarness = makeApi(PROPOSED)
    const popHosts = mountHosts()
    attachDiffState(popout, popHarness.api, { revealOnShowDiff: false })
    mountGitChangesPane(
      popHosts.listRoot,
      popHosts.viewerRoot,
      popout,
      popHarness.api,
      makeMonacoStub({ createModel: 0, setModel: 0 }),
    )
    await applyPopoutSeed('changes', seed, popout)
    await settle()

    const selected = popHosts.listRoot.querySelector('.git-change-row.is-selected')
    assert.ok(selected, 'a row is selected in the pop-out')
    assert.ok(
      selected.classList.contains('git-change-row-proposed'),
      'the seeded proposed selection survives the hand-off',
    )
    assert.match(selected.textContent, /x\.ts/)
  })
})

describe('#1704 proposed diff is not rebuilt for identical content', () => {
  it('skips the Monaco rebuild when a refresh resolves to the same diff', async () => {
    // `refresh()` re-enters selectProposed on every fs change and panel toggle.
    // Rebuilding identical models re-runs revealFirstDiffChange, throwing the
    // reader's scroll back to the first hunk mid-review.
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      filesPaneOpen: true,
      rightPanelMode: 'changes',
    })
    store.setState({ stagedDiffs: [{ path: 'x.ts', language: 'typescript' }] })

    const counters: Counters = { createModel: 0, setModel: 0 }
    const { api, fireFsChanged } = makeApi(PROPOSED)
    const { listRoot, viewerRoot } = mountHosts()
    mountGitChangesPane(listRoot, viewerRoot, store, api, makeMonacoStub(counters))
    await settle()

    assert.equal(counters.createModel, 2, 'mount builds one original + one modified model')
    const afterMount = counters.setModel

    for (let round = 0; round < 3; round++) {
      fireFsChanged()
      await settle(700)
    }

    assert.equal(counters.createModel, 2, 'identical content must not rebuild models')
    assert.equal(counters.setModel, afterMount, 'and must not re-attach a view model')
  })

  it('still rebuilds when the proposed content actually changes', async () => {
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      filesPaneOpen: true,
      rightPanelMode: 'changes',
    })
    store.setState({ stagedDiffs: [{ path: 'x.ts', language: 'typescript' }] })

    const counters: Counters = { createModel: 0, setModel: 0 }
    const staged: Record<string, ActiveDiff> = {
      'x.ts': { path: 'x.ts', before: 'old\n', after: 'new\n', language: 'typescript' },
    }
    const { api, fireFsChanged } = makeApi(staged)
    const { listRoot, viewerRoot } = mountHosts()
    mountGitChangesPane(listRoot, viewerRoot, store, api, makeMonacoStub(counters))
    await settle()
    assert.equal(counters.createModel, 2)

    // The agent revises its proposal for the same path.
    staged['x.ts'] = {
      path: 'x.ts',
      before: 'old\n',
      after: 'revised\n',
      language: 'typescript',
    }
    store.setState({ activeDiff: staged['x.ts'] })
    fireFsChanged()
    await settle(700)

    assert.equal(counters.createModel, 4, 'new content rebuilds both models')
  })
})
