import '../../../tests/setup-dom.ts'
import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type * as Monaco from 'monaco-editor'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GitStatusResult } from '@shared/types/git.ts'
import type { ActiveDiff } from '@shared/types/state.ts'
import { mountGitChangesPane } from './git-changes-pane.ts'

// Regression: a proposed diff must render even when this pane never received the
// `agent:show_diff` push carrying its content. The pane mounts a turn after the
// agent proposes (Monaco loads async, #459) or is remounted on popout/workspace
// switch, so the push can be missed and the in-memory cache stays empty. The pane
// then falls back to fetching the content the main-process queue still holds via
// `api.diff.content`; without that fallback the viewer cleared to an empty pane —
// "the diff viewer often never shows the diff".

const emptyStatus: GitStatusResult = { staged: [], unstaged: [] }

interface StubModel {
  value: string
  dispose(): void
  isDisposed(): boolean
}

interface StubDiffEditor {
  models: { original: StubModel; modified: StubModel } | null
}

function makeMonacoStub(capture: { editor: StubDiffEditor | null }): typeof Monaco {
  const noopEditor = {
    onKeyDown: (): { dispose(): void } => ({ dispose(): void {} }),
  }
  const createModel = (value: string): StubModel => ({
    value,
    dispose(): void {},
    isDisposed: () => false,
  })
  return {
    editor: {
      createDiffEditor: (): unknown => {
        const listeners = new Set<() => void>()
        const self: StubDiffEditor & Record<string, unknown> = {
          models: null,
          getOriginalEditor: () => noopEditor,
          getModifiedEditor: () => noopEditor,
          onDidUpdateDiff: (cb: () => void) => {
            listeners.add(cb)
            return {
              dispose(): void {
                listeners.delete(cb)
              },
            }
          },
          getModel: () => self.models,
          setModel: (models: { original: StubModel; modified: StubModel } | null) => {
            self.models = models
            // Mirror Monaco: the diff recomputes asynchronously after setModel.
            queueMicrotask(() => {
              for (const cb of [...listeners]) cb()
            })
          },
          updateOptions: (): void => {},
          layout: (): void => {},
          getLineChanges: () => [],
          dispose: (): void => {},
        }
        capture.editor = self
        return self
      },
      createModel: (value: string): StubModel => createModel(value),
    },
  } as unknown as typeof Monaco
}

function makeApi(stagedContent: Record<string, ActiveDiff>, contentCalls: string[]): ApiClient {
  const noopUnsub = (): (() => void) => () => {}
  return {
    git: {
      isAvailable: async () => true,
      status: async () => emptyStatus,
      fileDiff: async () => null,
    },
    diff: {
      approve: async () => {},
      reject: async () => {},
      approveAll: async () => {},
      rejectAll: async () => {},
      content: async (path: string) => {
        contentCalls.push(path)
        return stagedContent[path] ?? null
      },
      onShowDiff: noopUnsub(),
      onQueued: noopUnsub(),
      onConflict: noopUnsub(),
    },
    fs: {
      onChanged: noopUnsub(),
    },
  } as unknown as ApiClient
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

// whenDiffHostVisible gates rendering on the host reporting a non-zero size;
// happy-dom reports 0, so force the viewer host visible for these assertions.
function forceVisible(el: HTMLElement): void {
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: 100 })
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: 100 })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('git changes pane fetches proposed diff content on cache miss', () => {
  it('renders a proposed diff whose show_diff push was never received', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'changes' })
    store.setState({ stagedDiffs: [{ path: 'x.ts', language: 'typescript' }] })

    const contentCalls: string[] = []
    const api = makeApi(
      { 'x.ts': { path: 'x.ts', before: 'old\n', after: 'new\n', language: 'typescript' } },
      contentCalls,
    )
    const capture: { editor: StubDiffEditor | null } = { editor: null }
    const monaco = makeMonacoStub(capture)

    const listRoot = document.createElement('div')
    const viewerRoot = document.createElement('div')
    forceVisible(viewerRoot)
    document.body.append(listRoot, viewerRoot)

    mountGitChangesPane(listRoot, viewerRoot, store, api, monaco)
    await settle()

    assert.deepEqual(contentCalls, ['x.ts'], 'should fetch the uncached proposed content once')
    const models = capture.editor?.models
    assert.ok(models, 'diff editor should have a model set')
    assert.equal(models.original.value, 'old\n', 'before content rendered')
    assert.equal(models.modified.value, 'new\n', 'after content rendered')
  })

  it('clears the viewer when the queue entry has no retrievable content', async () => {
    const store = createStore({ filesPaneOpen: true, rightPanelMode: 'changes' })
    store.setState({ stagedDiffs: [{ path: 'gone.ts', language: 'typescript' }] })

    const contentCalls: string[] = []
    const api = makeApi({}, contentCalls)
    const capture: { editor: StubDiffEditor | null } = { editor: null }
    const monaco = makeMonacoStub(capture)

    const listRoot = document.createElement('div')
    const viewerRoot = document.createElement('div')
    forceVisible(viewerRoot)
    document.body.append(listRoot, viewerRoot)

    mountGitChangesPane(listRoot, viewerRoot, store, api, monaco)
    await settle()

    assert.deepEqual(contentCalls, ['gone.ts'], 'should attempt the fetch once')
    assert.equal(capture.editor?.models ?? null, null, 'no model set when content is unavailable')
  })
})
