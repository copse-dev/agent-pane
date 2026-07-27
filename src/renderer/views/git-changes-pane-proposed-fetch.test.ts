import '../../../tests/setup-dom.ts'
import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type * as Monaco from 'monaco-editor'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GitStatusResult } from '@shared/types/git.ts'
import type { ActiveDiff } from '@shared/types/state.ts'
import { mountGitChangesPane } from './git-changes-pane.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

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
  revealLineCalls: number[]
  activeDiffComputations: number
  maxActiveDiffComputations: number
}

function makeMonacoStub(
  capture: { editor: StubDiffEditor | null },
  diffDelayMs: (modifiedValue: string) => number = () => 0,
): typeof Monaco {
  const noopEditor = {
    onKeyDown: (): { dispose(): void } => ({ dispose(): void {} }),
  }
  const createModel = (value: string): StubModel => ({
    value,
    dispose(): void {},
    isDisposed: () => false,
  })
  return {
    Uri: {
      parse: (value: string): { toString(): string } => ({
        toString: () => value,
      }),
    },
    editor: {
      createDiffEditor: (): unknown => {
        const listeners = new Set<() => void>()
        const notify = (): void => {
          for (const cb of [...listeners]) cb()
        }
        const self: StubDiffEditor & Record<string, unknown> = {
          models: null,
          revealLineCalls: [],
          activeDiffComputations: 0,
          maxActiveDiffComputations: 0,
          getOriginalEditor: () => ({
            ...noopEditor,
            revealLineInCenterIfOutsideViewport: (line: number): void => {
              self.revealLineCalls.push(line)
            },
          }),
          getModifiedEditor: () => ({
            ...noopEditor,
            revealLineInCenterIfOutsideViewport: (line: number): void => {
              self.revealLineCalls.push(line)
            },
          }),
          onDidUpdateDiff: (cb: () => void) => {
            listeners.add(cb)
            return {
              dispose(): void {
                listeners.delete(cb)
              },
            }
          },
          getModel: () => self.models,
          setModel: (
            models:
              | { original: StubModel; modified: StubModel }
              | { model: { original: StubModel; modified: StubModel } }
              | null,
          ) => {
            if (models && 'model' in models) {
              self.models = models.model
            } else if (models && 'original' in models) {
              self.models = models
            } else {
              self.models = null
            }
            // Mirror Monaco: the diff recomputes asynchronously after setModel.
            queueMicrotask(notify)
          },
          createViewModel: (model: { original: StubModel; modified: StubModel }) => ({
            model,
            waitForDiff: async (): Promise<void> => {
              self.activeDiffComputations++
              self.maxActiveDiffComputations = Math.max(
                self.maxActiveDiffComputations,
                self.activeDiffComputations,
              )
              try {
                const delayMs = diffDelayMs(model.modified.value)
                if (delayMs > 0) {
                  await new Promise<void>((resolve) => {
                    setTimeout(resolve, delayMs)
                  })
                }
              } finally {
                self.activeDiffComputations--
              }
            },
            dispose: (): void => {},
          }),
          updateOptions: (): void => {
            // Collapse refresh listens for a post-toggle update.
            queueMicrotask(notify)
          },
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
        capture.editor = self
        return self
      },
      createModel: (value: string): StubModel => createModel(value),
    },
  } as unknown as typeof Monaco
}

interface DiffListeners {
  showDiff?: (
    projectId: string,
    threadId: string,
    path: string,
    before: string,
    after: string,
    language: string,
  ) => void
}

function makeApi(
  stagedContent: Record<string, ActiveDiff>,
  contentCalls: string[],
  listeners?: DiffListeners,
): ApiClient {
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
        sessionBackup: async () => null,
      },
      diff: {
        ...base['diff'],
        approve: async (): Promise<void> => {},
        reject: async (): Promise<void> => {},
        approveAll: async (): Promise<void> => {},
        rejectAll: async (): Promise<void> => {},
        content: async (
          _projectId: string,
          _threadId: string,
          path: string,
        ): Promise<ActiveDiff | null> => {
          contentCalls.push(path)
          return stagedContent[path] ?? null
        },
        onShowDiff: (handler: NonNullable<DiffListeners['showDiff']>): (() => void) => {
          if (listeners) listeners.showDiff = handler
          return noopUnsub()
        },
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
  for (let i = 0; i < 30; i++) await Promise.resolve()
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

async function waitForReveal(capture: { editor: StubDiffEditor | null }): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if ((capture.editor?.revealLineCalls.length ?? 0) >= 1) return
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10)
    })
  }
}

async function waitForActiveDiff(capture: { editor: StubDiffEditor | null }): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if ((capture.editor?.activeDiffComputations ?? 0) > 0) return
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5)
    })
  }
  assert.fail('expected Monaco diff computation to start')
}

async function waitForModifiedValue(
  capture: { editor: StubDiffEditor | null },
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (capture.editor?.models?.modified.value === expected) return
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5)
    })
  }
  assert.fail(`expected modified model to become ${JSON.stringify(expected)}`)
}

describe('git changes pane fetches proposed diff content on cache miss', () => {
  it('renders a proposed diff whose show_diff push was never received', async () => {
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      filesPaneOpen: true,
      rightPanelMode: 'changes',
    })
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
    await waitForReveal(capture)

    assert.deepEqual(contentCalls, ['x.ts'], 'should fetch the uncached proposed content once')
    const models = capture.editor?.models
    assert.ok(models, 'diff editor should have a model set')
    assert.equal(models.original.value, 'old\n', 'before content rendered')
    assert.equal(models.modified.value, 'new\n', 'after content rendered')
    assert.ok(
      (capture.editor?.revealLineCalls.length ?? 0) >= 1,
      'should reveal the first change after the model is ready',
    )
  })

  it('clears the viewer when the queue entry has no retrievable content', async () => {
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      filesPaneOpen: true,
      rightPanelMode: 'changes',
    })
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

  it('keeps same-path content isolated when switching between threads', async () => {
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-a',
      filesPaneOpen: true,
      rightPanelMode: 'changes',
    })
    store.setState({ stagedDiffs: [{ path: 'same.ts', language: 'typescript' }] })

    const listeners: DiffListeners = {}
    const capture: { editor: StubDiffEditor | null } = { editor: null }
    const listRoot = document.createElement('div')
    const viewerRoot = document.createElement('div')
    forceVisible(viewerRoot)
    document.body.append(listRoot, viewerRoot)

    mountGitChangesPane(
      listRoot,
      viewerRoot,
      store,
      makeApi({}, [], listeners),
      makeMonacoStub(capture),
    )
    listeners.showDiff?.(
      'project-1',
      'thread-a',
      'same.ts',
      'a-before\n',
      'a-after\n',
      'typescript',
    )
    await settle()

    store.setState({ activeThreadId: 'thread-b', activeDiff: null })
    listeners.showDiff?.(
      'project-1',
      'thread-b',
      'same.ts',
      'b-before\n',
      'b-after\n',
      'typescript',
    )
    await waitForModifiedValue(capture, 'b-after\n')

    store.setState({ activeThreadId: 'thread-a', activeDiff: null })
    store.emit('staged_diffs_changed')
    await waitForModifiedValue(capture, 'a-after\n')
    const models = capture.editor?.models
    assert.ok(models, 'expected thread-a models to be restored')
    assert.equal(models.original.value, 'a-before\n')
    assert.equal(models.modified.value, 'a-after\n')
  })

  it('serializes proposed model computation and only attaches the latest selection', async () => {
    const store = createStore({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      filesPaneOpen: true,
      rightPanelMode: 'changes',
    })
    store.setState({
      stagedDiffs: [
        { path: 'slow.ts', language: 'typescript' },
        { path: 'fast.ts', language: 'typescript' },
      ],
    })

    const api = makeApi(
      {
        'slow.ts': {
          path: 'slow.ts',
          before: 'slow-before\n',
          after: 'slow-after\n',
          language: 'typescript',
        },
        'fast.ts': {
          path: 'fast.ts',
          before: 'fast-before\n',
          after: 'fast-after\n',
          language: 'typescript',
        },
      },
      [],
    )
    const capture: { editor: StubDiffEditor | null } = { editor: null }
    const monaco = makeMonacoStub(capture, (value) => (value === 'slow-after\n' ? 80 : 5))
    const listRoot = document.createElement('div')
    const viewerRoot = document.createElement('div')
    forceVisible(viewerRoot)
    document.body.append(listRoot, viewerRoot)

    mountGitChangesPane(listRoot, viewerRoot, store, api, monaco)
    await waitForActiveDiff(capture)

    const fastRow = [
      ...listRoot.querySelectorAll<HTMLButtonElement>('.git-change-row-proposed'),
    ].find((row) => row.textContent.includes('fast.ts'))
    assert.ok(fastRow, 'expected the second proposed file row')
    fastRow.click()

    await waitForReveal(capture)
    const editor = capture.editor
    assert.ok(editor, 'expected the diff editor')
    const models = editor.models
    assert.ok(models, 'expected the latest diff models')

    assert.equal(
      editor.maxActiveDiffComputations,
      1,
      'Monaco view-model computations must not overlap',
    )
    assert.equal(models.original.value, 'fast-before\n')
    assert.equal(models.modified.value, 'fast-after\n')
  })
})
