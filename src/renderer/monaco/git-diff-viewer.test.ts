import '../../../tests/setup-dom.ts'
import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
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

interface FakeDiff {
  monaco: GitDiffMonaco
  editor: GitDiffEditor
  /** Values of every model/view model released, in disposal order. */
  disposed: string[]
  /** Let the diff currently being computed finish. */
  finishDiff: () => void
}

/** Minimal Monaco doubles: enough surface for setGitFileDiffModel's swap. */
function createFakeDiff(): FakeDiff {
  const disposed: string[] = []
  let attached: { original: GitDiffModel; modified: GitDiffModel } | null = null
  let releaseDiff: (() => void) | null = null

  const model = (value: string): GitDiffModel => ({
    getValue: () => value,
    dispose: () => disposed.push(value),
  })

  const codeEditor = (): GitDiffCodeEditor => ({
    revealLineInCenterIfOutsideViewport: (): void => {},
    getSelection: () => null,
    getModel: () => null,
    onKeyDown: () => ({ dispose: (): void => {} }),
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
    getLineChanges: () => [],
    getModel: () => attached,
    getModifiedEditor: codeEditor,
    getOriginalEditor: codeEditor,
    layout: (): void => {},
    onDidUpdateDiff: () => ({ dispose: (): void => {} }),
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
