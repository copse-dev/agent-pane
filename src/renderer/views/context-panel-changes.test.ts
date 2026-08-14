import '../../../tests/setup-dom.ts'
import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GitFileDiff } from '@shared/types/git.ts'
import type { OpenFile } from '@shared/types'
import {
  mountContextPanel,
  type ContextPanelEditor,
  type ContextPanelModel,
  type ContextPanelMonaco,
} from './context-panel.ts'
import type { GitDiffEditor } from '../monaco/git-diff-viewer.ts'
import { createFakeApi } from '../fake-api.test-support.ts'

// The file viewer's "Changes" view (uncommitted HEAD → working-tree diff for
// the open file). These tests cover the toolbar/visibility logic in happy-dom;
// the actual Monaco diff rendering runs in the file-viewer-changes e2e spec.

function makeModel(value: string): ContextPanelModel {
  let content = value
  return {
    dispose(): void {},
    getValue: () => content,
    getValueInRange: () => content,
    isDisposed: () => false,
    setValue(next: string): void {
      content = next
    },
  }
}

function makeCodeEditorStub(): ContextPanelEditor {
  let model: ContextPanelModel | null = null
  return {
    addCommand(): void {},
    onKeyDown: () => ({ dispose(): void {} }),
    getSelection: () => null,
    getModel: () => model,
    setModel(next: ContextPanelModel | null): void {
      model = next
    },
    revealLineInCenter(): void {},
    revealLineInCenterIfOutsideViewport(): void {},
    setPosition(): void {},
    layout(): void {},
    hasTextFocus: () => false,
    getValue: () => '',
    dispose(): void {},
  }
}

function makeDiffEditorStub(): GitDiffEditor {
  let models: ReturnType<GitDiffEditor['getModel']> = null
  return {
    createViewModel: (model): ReturnType<GitDiffEditor['createViewModel']> => ({
      model,
      dispose(): void {},
      waitForDiff: async (): Promise<void> => {},
    }),
    dispose(): void {},
    getLineChanges: () => null,
    getModel: () => models,
    getModifiedEditor: makeCodeEditorStub,
    getOriginalEditor: makeCodeEditorStub,
    layout(): void {},
    onDidUpdateDiff: () => ({ dispose(): void {} }),
    setModel(next): void {
      if (next === null) models = null
      else if ('original' in next) models = next
      else if (next.model) models = next.model
    },
    updateOptions(): void {},
  }
}

function makeMonacoStub(): ContextPanelMonaco {
  return {
    editor: {
      create: () => makeCodeEditorStub(),
      createDiffEditor: makeDiffEditorStub,
      createModel: makeModel,
      setTheme(): void {},
    },
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49, KeyL: 42 },
    Uri: { parse: (value: string) => value },
  }
}

type FsChangedHandler = (
  projectId: string,
  threadId: string,
  path: string,
  newContent: string | null,
) => void

interface ContextPanelCapture {
  fsChanged?: FsChangedHandler
  previewRequests?: Array<{ projectId: string; threadId: string; path: string }>
  externalRequests?: Array<{ projectId: string; threadId: string; path: string }>
  openedBrowserUrls?: string[]
}

function makeApi(
  diffByPath: Record<string, GitFileDiff | null>,
  capture?: ContextPanelCapture,
): ApiClient {
  return ((): ApiClient => {
    const base = createFakeApi()
    return {
      ...base,
      git: {
        ...base['git'],
        workingFileDiff: async (_projectId: string, _threadId: string, path: string) =>
          diffByPath[path] ?? null,
      },
      fs: {
        ...base['fs'],
        onChanged: (handler: FsChangedHandler) => {
          if (capture) capture.fsChanged = handler
          return () => {}
        },
        watch: async (): Promise<void> => {},
        unwatch: async (): Promise<void> => {},
        readFile: async () => '',
        writeFile: async (): Promise<void> => {},
      },
      browser: {
        ...base['browser'],
        workspaceFileUrl: async (projectId, threadId, path): Promise<string> => {
          capture?.previewRequests?.push({ projectId, threadId, path })
          return `http://localhost:4173/${path}`
        },
      },
      shell: {
        ...base['shell'],
        openWorkspaceFileInBrowser: async (projectId, threadId, path): Promise<void> => {
          capture?.externalRequests?.push({ projectId, threadId, path })
        },
      },
    } satisfies ApiClient
  })()
}

function openFileState(path: string, content: string, language: string): OpenFile {
  return { path, content, language }
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
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

function mount(
  diffByPath: Record<string, GitFileDiff | null>,
  openFile: OpenFile,
  capture?: ContextPanelCapture,
  sshHost?: string,
  openLinksInBuiltInBrowser = true,
): HTMLElement {
  const store = createStore({
    activeProjectId: 'project-1',
    activeThreadId: 'thread-1',
    projects: [
      {
        id: 'project-1',
        name: 'workspace',
        path: '/workspace',
        ...(sshHost ? { sshHost } : {}),
      },
    ],
    openFile,
    filesPaneOpen: true,
    openLinksInBuiltInBrowser,
  })
  store.on('browser_url_requested', (url) => capture?.openedBrowserUrls?.push(url))
  const root = document.createElement('div')
  document.body.append(root)
  mountContextPanel(root, store, makeApi(diffByPath, capture), makeMonacoStub())
  return root
}

function query(root: HTMLElement, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector)
  assert.ok(found, `expected ${selector} to exist`)
  return found
}

describe('file viewer Changes view', () => {
  it('opens a local file in the built-in browser by default from the viewer context menu', async () => {
    const capture: ContextPanelCapture = { previewRequests: [], openedBrowserUrls: [] }
    const root = mount({}, openFileState('docs/guide.html', '<h1>Guide</h1>\n', 'html'), capture)

    const contextMenuEvent = new window.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 32,
      clientY: 48,
    })
    root.dispatchEvent(contextMenuEvent)

    assert.equal(contextMenuEvent.defaultPrevented, true)
    const menuItem = query(document.body, '.context-menu-item')
    assert.equal(menuItem.textContent, 'Open in browser')
    menuItem.click()
    await flushAsync()
    assert.deepEqual(capture.previewRequests, [
      { projectId: 'project-1', threadId: 'thread-1', path: 'docs/guide.html' },
    ])
    assert.deepEqual(capture.openedBrowserUrls, ['http://localhost:4173/docs/guide.html'])
  })

  it('uses the default browser when built-in link opening is disabled', async () => {
    const capture: ContextPanelCapture = { externalRequests: [], openedBrowserUrls: [] }
    const root = mount(
      {},
      openFileState('docs/guide.html', '<h1>Guide</h1>\n', 'html'),
      capture,
      undefined,
      false,
    )

    root.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    query(document.body, '.context-menu-item').click()
    await flushAsync()

    assert.deepEqual(capture.externalRequests, [
      { projectId: 'project-1', threadId: 'thread-1', path: 'docs/guide.html' },
    ])
    assert.deepEqual(capture.openedBrowserUrls, [])
  })

  it('does not offer a local browser action for an SSH workspace file', () => {
    const root = mount(
      {},
      openFileState('docs/guide.html', '<h1>Guide</h1>\n', 'html'),
      undefined,
      'devbox',
    )

    const contextMenuEvent = new window.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    })
    root.dispatchEvent(contextMenuEvent)

    assert.equal(contextMenuEvent.defaultPrevented, false)
    assert.equal(document.querySelector('.context-menu'), null)
  })

  it('shows a Changes button for a file with uncommitted changes', async () => {
    const diff: GitFileDiff = {
      path: 'src/app.ts',
      before: 'export const a = 1\n',
      after: 'export const a = 2\n',
      language: 'typescript',
    }
    const root = mount(
      { 'src/app.ts': diff },
      openFileState('src/app.ts', 'export const a = 2\n', 'typescript'),
    )
    await flushAsync()

    const toolbar = query(root, '.file-viewer-toolbar')
    const changesBtn = query(root, '.file-viewer-changes-btn')
    const sourceBtn = query(root, '.file-viewer-source-btn')
    assert.equal(toolbar.hidden, false, 'toolbar should be visible for a changed file')
    assert.equal(changesBtn.hidden, false, 'Changes button should be visible')
    assert.equal(changesBtn.textContent, 'Changes')
    assert.equal(sourceBtn.textContent, 'Source', 'non-markdown files label the editor "Source"')
    assert.equal(query(root, '.file-viewer-preview-btn').hidden, true)
    assert.ok(sourceBtn.classList.contains('is-active'), 'source view is active by default')
    assert.equal(query(root, '.monaco-container').hidden, false)
    assert.equal(query(root, '.file-viewer-diff').hidden, true)
  })

  it('toggles between the diff view and the source editor', async () => {
    const diff: GitFileDiff = {
      path: 'src/app.ts',
      before: 'old\n',
      after: 'new\n',
      language: 'typescript',
    }
    const root = mount({ 'src/app.ts': diff }, openFileState('src/app.ts', 'new\n', 'typescript'))
    await flushAsync()

    const changesBtn = query(root, '.file-viewer-changes-btn')
    changesBtn.click()
    assert.ok(changesBtn.classList.contains('is-active'))
    assert.equal(query(root, '.file-viewer-diff').hidden, false, 'diff view should be shown')
    assert.equal(query(root, '.monaco-container').hidden, true, 'editor should be hidden')

    const sourceBtn = query(root, '.file-viewer-source-btn')
    sourceBtn.click()
    assert.ok(sourceBtn.classList.contains('is-active'))
    assert.equal(query(root, '.file-viewer-diff').hidden, true)
    assert.equal(query(root, '.monaco-container').hidden, false)
  })

  it('hides the toolbar entirely for a clean non-markdown file', async () => {
    const root = mount({}, openFileState('src/app.ts', 'export const a = 1\n', 'typescript'))
    await flushAsync()

    assert.equal(query(root, '.file-viewer-toolbar').hidden, true)
    assert.equal(query(root, '.monaco-container').hidden, false)
  })

  it('adds Changes alongside the markdown Preview/Edit source toggle', async () => {
    const diff: GitFileDiff = {
      path: 'README.md',
      before: '# Old\n',
      after: '# New\n',
      language: 'markdown',
    }
    const root = mount({ 'README.md': diff }, openFileState('README.md', '# New\n', 'markdown'))
    await flushAsync()

    const previewBtn = query(root, '.file-viewer-preview-btn')
    const sourceBtn = query(root, '.file-viewer-source-btn')
    assert.equal(previewBtn.hidden, false)
    assert.ok(previewBtn.classList.contains('is-active'), 'markdown defaults to preview')
    assert.equal(sourceBtn.textContent, 'Edit source')
    assert.equal(query(root, '.file-viewer-changes-btn').hidden, false)

    query(root, '.file-viewer-changes-btn').click()
    assert.equal(query(root, '.file-viewer-diff').hidden, false)
    assert.equal(query(root, '.markdown-file-preview').hidden, true)
  })

  it('reveals the Changes button when the file changes on disk', async () => {
    const diffByPath: Record<string, GitFileDiff | null> = { 'src/app.ts': null }
    const capture: { fsChanged?: FsChangedHandler } = {}
    const root = mount(
      diffByPath,
      openFileState('src/app.ts', 'export const a = 1\n', 'typescript'),
      capture,
    )
    await flushAsync()
    assert.equal(query(root, '.file-viewer-toolbar').hidden, true)

    diffByPath['src/app.ts'] = {
      path: 'src/app.ts',
      before: 'export const a = 1\n',
      after: 'export const a = 2\n',
      language: 'typescript',
    }
    capture.fsChanged?.('project-1', 'thread-1', 'src/app.ts', 'export const a = 2\n')
    await flushAsync()

    assert.equal(query(root, '.file-viewer-toolbar').hidden, false)
    assert.equal(query(root, '.file-viewer-changes-btn').hidden, false)
  })
})
