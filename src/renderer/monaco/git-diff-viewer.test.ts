import '../../../tests/setup-dom.ts'
import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createGitChangesDiffEditor,
  disposeDiffModels,
  setGitFileDiffModel,
  whenDiffHostVisible,
  type GitDiffCodeEditor,
  type GitDiffEditor,
  type GitDiffModel,
  type GitDiffMonaco,
  type GitDiffViewModel,
} from './git-diff-viewer.ts'

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

function forceSize(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: width })
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height })
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out after ${String(timeoutMs)}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

type LineChanges = ReturnType<GitDiffEditor['getLineChanges']>

interface FakeDiff {
  monaco: GitDiffMonaco
  editor: GitDiffEditor
  /** Values of every model/view model released, in disposal order. */
  disposed: string[]
  /** Let the diff currently being computed finish. */
  finishDiff: () => void
  /** What getLineChanges answers: null = compute still pending. */
  setLineChanges: (value: LineChanges) => void
  /** Whether the (finished) compute hit maxComputationTime and gave up. */
  setQuitEarly: (value: boolean) => void
  /** Emit the editor's onDidUpdateDiff to every live listener. */
  fireDiffUpdated: () => void
  /** Live onDidUpdateDiff listeners (armed pending presentations). */
  listenerCount: () => number
  counts: { reveal: number }
}

/** Minimal Monaco doubles: enough surface for setGitFileDiffModel's swap. */
function createFakeDiff(): FakeDiff {
  const disposed: string[] = []
  let attached: { original: GitDiffModel; modified: GitDiffModel } | null = null
  let releaseDiff: (() => void) | null = null
  let lineChanges: LineChanges = []
  let quitEarly = false
  const diffUpdateListeners = new Set<() => void>()
  const counts = { reveal: 0 }

  const model = (value: string): GitDiffModel => ({
    getValue: () => value,
    dispose: () => disposed.push(value),
  })

  const codeEditor = (): GitDiffCodeEditor => ({
    revealLineInCenterIfOutsideViewport: (): void => {
      counts.reveal++
    },
    getSelection: () => null,
    getModel: () => null,
    onKeyDown: () => ({ dispose: (): void => {} }),
    updateOptions: (): void => {},
  })

  const editor: GitDiffEditor = {
    createViewModel: (models): GitDiffViewModel => ({
      model: models,
      dispose: (): void => {
        disposed.push(`viewModel(${models.modified.getValue()})`)
      },
      waitForDiff: async (): Promise<void> => {
        await new Promise<void>((resolve) => {
          releaseDiff = resolve
        })
      },
    }),
    dispose: (): void => {},
    getDiffComputationResult: () => (lineChanges === null ? null : { quitEarly }),
    getLineChanges: () => lineChanges,
    getModel: () => attached,
    getModifiedEditor: codeEditor,
    getOriginalEditor: codeEditor,
    layout: (): void => {},
    onDidUpdateDiff: (listener) => {
      diffUpdateListeners.add(listener)
      return {
        dispose: (): void => {
          diffUpdateListeners.delete(listener)
        },
      }
    },
    setModel: (next): void => {
      attached = next === null || !('model' in next) ? null : (next.model ?? null)
    },
    updateOptions: (): void => {},
  }

  const monaco: GitDiffMonaco = {
    KeyCode: { KeyL: 0 },
    editor: {
      createDiffEditor: (): GitDiffEditor => editor,
      createModel: (value: string): GitDiffModel => model(value),
      setTheme: (): void => {},
    },
    Uri: { parse: (value: string): { toString: () => string } => ({ toString: () => value }) },
  }

  return {
    monaco,
    editor,
    disposed,
    finishDiff: (): void => {
      const resolve = releaseDiff
      releaseDiff = null
      resolve?.()
    },
    setLineChanges: (value): void => {
      lineChanges = value
    },
    setQuitEarly: (value): void => {
      quitEarly = value
    },
    fireDiffUpdated: (): void => {
      for (const listener of [...diffUpdateListeners]) listener()
    },
    listenerCount: () => diffUpdateListeners.size,
    counts,
  }
}

/** Spin the microtask queue so an in-flight attach reaches its next await. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('setGitFileDiffModel keeps a diff on screen while the next one computes', () => {
  it('leaves the previous model attached when the attach is superseded', async () => {
    const host = document.createElement('div')
    forceSize(host, 400, 300)
    document.body.append(host)
    const fake = createFakeDiff()
    const { monaco, editor, disposed } = fake

    const first = setGitFileDiffModel(
      editor,
      monaco,
      { path: 'a.ts', before: 'a-before', after: 'a-after', language: 'typescript' },
      host,
    )
    await flush()
    fake.finishDiff()
    assert.equal(await withDeadline(first), true)
    assert.equal(editor.getModel()?.modified.getValue(), 'a-after')

    // A second selection is superseded while its diff is still computing — a
    // store event re-entering selectProposed/selectGitChange, or a thread or
    // project switch. Tearing the old diff down up front left the editor
    // model-less right here, behind a Changes pane that had already unhidden
    // the wrap and hidden its empty state: the blank page of #459/#1343.
    let current = true
    const superseded = setGitFileDiffModel(
      editor,
      monaco,
      { path: 'b.ts', before: 'b-before', after: 'b-after', language: 'typescript' },
      host,
      () => current,
    )
    await flush()
    current = false
    fake.finishDiff()

    assert.equal(await withDeadline(superseded), false)
    assert.equal(
      editor.getModel()?.modified.getValue(),
      'a-after',
      'an abandoned attach must not strand the viewer on an empty editor',
    )
    assert.deepEqual(
      disposed.filter((entry) => entry.includes('b-')).sort(),
      ['b-after', 'b-before', 'viewModel(b-after)'],
      'the abandoned diff is released',
    )
    assert.equal(disposed.includes('a-after'), false, 'the visible models stay alive')
  })

  it('releases the outgoing diff once its replacement is attached', async () => {
    const host = document.createElement('div')
    forceSize(host, 400, 300)
    document.body.append(host)
    const fake = createFakeDiff()
    const { monaco, editor, disposed } = fake

    for (const name of ['a', 'b']) {
      const attach = setGitFileDiffModel(
        editor,
        monaco,
        { path: `${name}.ts`, before: `${name}-before`, after: `${name}-after`, language: 'ts' },
        host,
      )
      await flush()
      fake.finishDiff()
      assert.equal(await withDeadline(attach), true)
    }

    assert.equal(editor.getModel()?.modified.getValue(), 'b-after')
    assert.deepEqual(
      disposed.sort(),
      ['a-after', 'a-before', 'viewModel(a-after)'],
      'the replaced diff is released, wrapper included',
    )

    disposeDiffModels(editor)
    assert.equal(editor.getModel(), null)
    assert.ok(
      disposed.includes('viewModel(b-after)'),
      'clearing the viewer releases the attached wrapper too',
    )
  })

  it('skips rebuild when the attached before/after are unchanged', async () => {
    const host = document.createElement('div')
    forceSize(host, 400, 300)
    document.body.append(host)
    const fake = createFakeDiff()
    const { monaco, editor, disposed } = fake
    const diff = { path: 'a.ts', before: 'same-before', after: 'same-after', language: 'ts' }

    let createCount = 0
    // Bound eagerly: the spy below replaces `monaco.editor.createModel`, so the
    // original has to be captured now rather than looked up at call time.
    const createModel = monaco.editor.createModel.bind(monaco.editor)
    monaco.editor.createModel = (value, language, uri): ReturnType<typeof createModel> => {
      createCount++
      return createModel(value, language, uri)
    }

    const first = setGitFileDiffModel(editor, monaco, diff, host)
    await flush()
    fake.finishDiff()
    assert.equal(await withDeadline(first), true)
    assert.equal(createCount, 2)

    const second = setGitFileDiffModel(editor, monaco, diff, host)
    await flush()
    // No waitForDiff to finish — a no-op must not start another compute.
    assert.equal(await withDeadline(second), true)
    assert.equal(createCount, 2, 'identical refresh must not mint new models')
    assert.equal(disposed.length, 0, 'identical refresh must not dispose the visible diff')
    assert.equal(editor.getModel()?.modified.getValue(), 'same-after')
  })

  it('still rebuilds for a different file whose content happens to match', async () => {
    // Content equality alone cannot tell "same file, refreshed" from "different
    // file that reads identically" — short-circuiting the latter would leave the
    // previous file's models, and its language, under the new selection.
    const host = document.createElement('div')
    forceSize(host, 400, 300)
    document.body.append(host)
    const fake = createFakeDiff()
    const { monaco, editor } = fake
    const shared = { before: 'same-before', after: 'same-after' }

    const languages: (string | undefined)[] = []
    const createModel = monaco.editor.createModel.bind(monaco.editor)
    monaco.editor.createModel = (value, language, uri): ReturnType<typeof createModel> => {
      languages.push(language)
      return createModel(value, language, uri)
    }

    const first = setGitFileDiffModel(
      editor,
      monaco,
      { path: 'a.ts', ...shared, language: 'typescript' },
      host,
    )
    await flush()
    fake.finishDiff()
    assert.equal(await withDeadline(first), true)

    const second = setGitFileDiffModel(
      editor,
      monaco,
      { path: 'b.py', ...shared, language: 'python' },
      host,
    )
    await flush()
    fake.finishDiff()
    assert.equal(await withDeadline(second), true)
    assert.deepEqual(
      languages,
      ['typescript', 'typescript', 'python', 'python'],
      'a different path/language must mint its own models',
    )
  })
})

describe('a diff attached before its compute finished re-presents when it lands (#1753)', () => {
  const MID_FILE_CHANGE = [
    {
      originalStartLineNumber: 500,
      originalEndLineNumber: 500,
      modifiedStartLineNumber: 500,
      modifiedEndLineNumber: 500,
    },
  ]

  it('re-runs collapse + reveal on the diff update that completes the compute', async () => {
    const host = document.createElement('div')
    forceSize(host, 400, 300)
    document.body.append(host)
    const fake = createFakeDiff()
    const { monaco, editor, counts } = fake

    // Large diff: the attach budget expires while the worker is still computing,
    // so the attach lands with getLineChanges() null — plain uncoloured text,
    // nothing collapsed, nothing revealed.
    fake.setLineChanges(null)
    const attach = setGitFileDiffModel(
      editor,
      monaco,
      { path: 'huge.ts', before: 'h-before', after: 'h-after', language: 'typescript' },
      host,
    )
    await flush()
    fake.finishDiff()
    assert.equal(await withDeadline(attach, 2_000), true)
    const revealsBeforeCompute = counts.reveal
    assert.equal(revealsBeforeCompute, 0, 'nothing to reveal while the compute is pending')

    // The worker finishes: the editor emits a diff update with real line changes.
    fake.setLineChanges(MID_FILE_CHANGE)
    fake.fireDiffUpdated()
    await withDeadline(
      new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (counts.reveal > 0) {
            clearInterval(poll)
            resolve()
          }
        }, 10)
      }),
      2_000,
    )
    assert.ok(counts.reveal >= 1, 'the late compute must be presented (revealed) when it lands')
  })

  it('re-presents an unpresented attach on an identical-content refresh', async () => {
    const host = document.createElement('div')
    forceSize(host, 400, 300)
    document.body.append(host)
    const fake = createFakeDiff()
    const { monaco, editor, counts } = fake
    const diff = { path: 'huge.ts', before: 'h-before', after: 'h-after', language: 'typescript' }

    let createCount = 0
    const createModel = monaco.editor.createModel.bind(monaco.editor)
    monaco.editor.createModel = (value, language, uri): ReturnType<typeof createModel> => {
      createCount++
      return createModel(value, language, uri)
    }

    fake.setLineChanges(null)
    const attach = setGitFileDiffModel(editor, monaco, diff, host)
    await flush()
    fake.finishDiff()
    assert.equal(await withDeadline(attach, 2_000), true)
    assert.equal(createCount, 2)
    const revealsAfterAttach = counts.reveal
    assert.equal(revealsAfterAttach, 0)

    // The compute finishes but its update event was missed (e.g. the arming
    // selection was superseded). The next refresh resolves to identical content
    // — it must re-present rather than pin the uncoloured view.
    fake.setLineChanges(MID_FILE_CHANGE)
    const second = setGitFileDiffModel(editor, monaco, diff, host)
    assert.equal(await withDeadline(second, 2_000), true)
    assert.equal(createCount, 2, 'identical refresh must still not mint new models')
    assert.ok(counts.reveal >= 1, 'the healed presentation reveals the first change')

    // Once presented, further identical refreshes go back to skipping outright.
    const revealsAfterHeal = counts.reveal
    const third = setGitFileDiffModel(editor, monaco, diff, host)
    assert.equal(await withDeadline(third, 2_000), true)
    assert.equal(counts.reveal, revealsAfterHeal, 'a presented diff is not re-revealed')
  })

  it('does not latch a quit-early compute as presented; the next entry rebuilds', async () => {
    const host = document.createElement('div')
    forceSize(host, 400, 300)
    document.body.append(host)
    const fake = createFakeDiff()
    const { monaco, editor } = fake
    const diff = { path: 'huge.ts', before: 'h-before', after: 'h-after', language: 'typescript' }

    let createCount = 0
    const createModel = monaco.editor.createModel.bind(monaco.editor)
    monaco.editor.createModel = (value, language, uri): ReturnType<typeof createModel> => {
      createCount++
      return createModel(value, language, uri)
    }

    // The compute hit maxComputationTime: it reports non-null line changes (one
    // degenerate whole-file hunk) but quitEarly — nothing worth preserving.
    fake.setLineChanges([
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 2_000,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 2_000,
      },
    ])
    fake.setQuitEarly(true)
    const attach = setGitFileDiffModel(editor, monaco, diff, host)
    await flush()
    fake.finishDiff()
    assert.equal(await withDeadline(attach, 2_000), true)
    assert.equal(createCount, 2)

    // Re-entry with identical content: a quit-early presentation must fall
    // through the identical-content skip to a full model rebuild — a fresh
    // compute is the only way to heal it (Monaco will not recompute for the
    // same models).
    fake.setQuitEarly(false)
    fake.setLineChanges(MID_FILE_CHANGE)
    const second = setGitFileDiffModel(editor, monaco, diff, host)
    await flush()
    fake.finishDiff()
    assert.equal(await withDeadline(second, 2_000), true)
    assert.equal(createCount, 4, 'a quit-early presentation must rebuild, not skip')

    // Once presented from a finished compute, identical refreshes skip again.
    const third = setGitFileDiffModel(editor, monaco, diff, host)
    assert.equal(await withDeadline(third, 2_000), true)
    assert.equal(createCount, 4, 'a healed diff goes back to the no-op skip')
  })

  it('drops a stale late-compute listener when a new attach begins', async () => {
    const host = document.createElement('div')
    forceSize(host, 400, 300)
    document.body.append(host)
    const fake = createFakeDiff()
    const { monaco, editor, counts } = fake

    fake.setLineChanges(null)
    const first = setGitFileDiffModel(
      editor,
      monaco,
      { path: 'a.ts', before: 'a-before', after: 'a-after', language: 'typescript' },
      host,
    )
    await flush()
    fake.finishDiff()
    assert.equal(await withDeadline(first, 2_000), true)
    assert.equal(fake.listenerCount(), 1, 'the unfinished compute arms a one-shot listener')
    const revealsAfterAttach = counts.reveal
    assert.equal(revealsAfterAttach, 0)

    // A different file attaches through the same editor without isCurrent
    // (context-panel's default). File A's armed listener must be dropped before
    // any model work: B's setModel emits diff updates, which would fire the
    // stale listener into a duplicate presentAttachedDiff racing B's own.
    const second = setGitFileDiffModel(
      editor,
      monaco,
      { path: 'b.ts', before: 'b-before', after: 'b-after', language: 'typescript' },
      host,
    )
    await flush()
    assert.equal(fake.listenerCount(), 0, 'the stale listener is dropped before model work')

    // The compute that would have satisfied A's listener lands mid-attach.
    fake.setLineChanges(MID_FILE_CHANGE)
    fake.fireDiffUpdated()
    await flush()
    const revealsMidAttach = counts.reveal
    assert.equal(revealsMidAttach, 0, 'no duplicate presentation from the stale listener')

    fake.finishDiff()
    assert.equal(await withDeadline(second, 2_000), true)
    assert.ok(counts.reveal >= 1, "the new attach's own presentation still runs")
  })
})

describe('whenDiffHostVisible', () => {
  it('resolves true immediately when the host already has a layout box', async () => {
    const host = document.createElement('div')
    forceSize(host, 120, 80)
    document.body.append(host)
    await assert.doesNotReject(async () => {
      assert.equal(await whenDiffHostVisible(host), true)
    })
  })

  it('abandons a hidden-host wait when isCurrent flips false', async () => {
    const host = document.createElement('div')
    host.hidden = true
    forceSize(host, 0, 0)
    document.body.append(host)

    let current = true
    const pending = whenDiffHostVisible(host, () => current)
    // Superseded selection (panel still closed) must release the waiter —
    // otherwise the Changes pane's shared diffLoadQueue stalls forever and
    // flicking files never attaches a model.
    current = false
    const started = Date.now()
    assert.equal(await withDeadline(pending), false)
    assert.ok(Date.now() - started < 500, 'stale wait must not block on visibility')
  })

  it('resolves true after the host becomes visible', async () => {
    const host = document.createElement('div')
    host.hidden = true
    forceSize(host, 0, 0)
    document.body.append(host)

    const pending = whenDiffHostVisible(host)
    queueMicrotask(() => {
      host.hidden = false
      forceSize(host, 200, 100)
    })
    assert.equal(await withDeadline(pending), true)
  })
})

describe('createGitChangesDiffEditor keeps a single gutter in the inline view', () => {
  async function waitForCalls(calls: unknown[], count: number): Promise<void> {
    const deadline = Date.now() + 2_000
    while (calls.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  it('hides original line numbers while inline and restores them side-by-side', async () => {
    const container = document.createElement('div')
    document.body.append(container)

    const lineNumberModes: unknown[] = []
    const originalEditor: GitDiffCodeEditor = {
      revealLineInCenterIfOutsideViewport: (): void => {},
      getSelection: () => null,
      getModel: () => null,
      onKeyDown: () => ({ dispose: (): void => {} }),
      updateOptions: (options): void => {
        lineNumberModes.push(options.lineNumbers)
      },
    }
    const fake = createFakeDiff()
    const editor: GitDiffEditor = { ...fake.editor, getOriginalEditor: () => originalEditor }
    const monaco: GitDiffMonaco = {
      ...fake.monaco,
      editor: {
        ...fake.monaco.editor,
        createDiffEditor: (host): GitDiffEditor => {
          // Mirror the piece of Monaco's DOM the gutter sync watches: the root
          // element whose `side-by-side` class tracks the active view.
          const fakeRoot = document.createElement('div')
          fakeRoot.className = 'monaco-diff-editor side-by-side'
          host.append(fakeRoot)
          return editor
        },
      },
    }

    createGitChangesDiffEditor(container, monaco, 12, 'vs')
    assert.deepEqual(lineNumberModes, ['on'], 'side-by-side keeps original line numbers')

    const root = container.querySelector('.monaco-diff-editor')
    assert.ok(root)
    root.classList.remove('side-by-side')
    await waitForCalls(lineNumberModes, 2)
    assert.deepEqual(lineNumberModes, ['on', 'off'], 'inline view drops the duplicate gutter')

    root.classList.add('side-by-side')
    await waitForCalls(lineNumberModes, 3)
    assert.deepEqual(lineNumberModes, ['on', 'off', 'on'], 'widening restores the gutter')
  })

  it('is a no-op when the editor factory builds no DOM', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const fake = createFakeDiff()
    // Test doubles (and Monaco failures) leave the container empty; creation
    // must still return the editor without touching sub-editor options.
    const created = createGitChangesDiffEditor(container, fake.monaco, 12, 'vs')
    assert.equal(created, fake.editor)
  })
})
