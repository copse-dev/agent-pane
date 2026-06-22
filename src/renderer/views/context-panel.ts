import type * as Monaco from 'monaco-editor'
import type { AppStore } from '@shared/store/store.ts'
import type { OpenFile } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { attachCodeBlockCopyButtons } from '../markdown/code-block-copy.ts'
import { renderMarkdown } from '../markdown/renderer.ts'
import { renderMermaidIn } from '../markdown/mermaid.ts'
import { annotateFileReferences, bindFileReferenceClicks } from '../markdown/file-links.ts'
import { bindFileDropTarget } from '../attachments/handle-file-drop.ts'
import { getPromptAttachmentHandlers } from '../attachments/prompt-attachments.ts'
import { showErrorToast } from './toast.ts'

type MarkdownViewMode = 'preview' | 'source'

function isMarkdownFile(openFile: OpenFile): boolean {
  if (openFile.language === 'markdown') return true
  const name = openFile.path.split('/').pop()?.toLowerCase() ?? ''
  return name.endsWith('.md') || name.endsWith('.mdx')
}

export function mountContextPanel(
  root: HTMLElement,
  store: AppStore,
  api: ApiClient,
  monaco: typeof Monaco,
): () => void {
  const fileToolbar = document.createElement('div')
  fileToolbar.className = 'file-viewer-toolbar'
  fileToolbar.hidden = true
  const previewBtn = document.createElement('button')
  previewBtn.type = 'button'
  previewBtn.textContent = 'Preview'
  const sourceBtn = document.createElement('button')
  sourceBtn.type = 'button'
  sourceBtn.textContent = 'Edit source'
  fileToolbar.append(previewBtn, sourceBtn)

  const previewContainer = document.createElement('div')
  previewContainer.className = 'markdown-file-preview message-text'
  previewContainer.hidden = true

  const fileContainer = document.createElement('div')
  fileContainer.className = 'monaco-container'
  const diffContainer = document.createElement('div')
  diffContainer.className = 'monaco-container diff-container'
  const emptyContainer = document.createElement('div')
  emptyContainer.className = 'panel-empty'
  emptyContainer.textContent = 'Open a file or run a task to see content here'

  root.append(fileToolbar, previewContainer, fileContainer, diffContainer, emptyContainer)

  let markdownViewMode: MarkdownViewMode = 'preview'
  let lastMarkdownPath: string | null = null

  function syncToolbarActive() {
    previewBtn.classList.toggle('is-active', markdownViewMode === 'preview')
    sourceBtn.classList.toggle('is-active', markdownViewMode === 'source')
  }

  function renderMarkdownPreview(content: string): void {
    previewContainer.innerHTML = renderMarkdown(content)
    attachCodeBlockCopyButtons(previewContainer)
    void annotateFileReferences(previewContainer, api)
    void renderMermaidIn(previewContainer)
  }

  previewBtn.addEventListener('click', () => {
    markdownViewMode = 'preview'
    const model = fileEditor.getModel()
    if (model && !model.isDisposed()) {
      renderMarkdownPreview(model.getValue())
    }
    syncToolbarActive()
    previewContainer.hidden = false
    fileContainer.hidden = true
  })

  sourceBtn.addEventListener('click', () => {
    markdownViewMode = 'source'
    syncToolbarActive()
    previewContainer.hidden = true
    fileContainer.hidden = false
    fileEditor.layout()
  })

  const fileEditor = monaco.editor.create(fileContainer, {
    readOnly: false,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    fontSize: store.getState().fontSize,
    theme: store.getState().theme === 'dark' ? 'vs-dark' : 'vs',
  })

  const diffEditor = monaco.editor.createDiffEditor(diffContainer, {
    readOnly: true,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    fontSize: store.getState().fontSize,
    theme: store.getState().theme === 'dark' ? 'vs-dark' : 'vs',
  })

  const acceptBtn = document.createElement('button')
  acceptBtn.textContent = 'Accept'
  acceptBtn.className = 'diff-accept-btn'
  const rejectBtn = document.createElement('button')
  rejectBtn.textContent = 'Reject'
  rejectBtn.className = 'diff-reject-btn'
  diffContainer.append(acceptBtn, rejectBtn)

  fileEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    const { openFile } = store.getState()
    if (openFile) {
      void api.fs.writeFile(openFile.path, fileEditor.getValue()).catch((err) => {
        showErrorToast(`Failed to save ${openFile.path}`, err)
      })
    }
  })

  function updatePanel() {
    const { openFile, activeDiff, panelTab, stagedDiffs } = store.getState()

    // Auto-switch to diff tab when staged diffs arrive
    if (stagedDiffs && stagedDiffs.length > 0 && panelTab !== 'diff') {
      store.setState({ panelTab: 'diff' })
      store.emit('panel_changed')
      return
    }

    if (panelTab === 'file' && openFile) {
      emptyContainer.hidden = true
      diffContainer.hidden = true

      const old = fileEditor.getModel()
      fileEditor.setModel(monaco.editor.createModel(openFile.content, openFile.language))
      old?.dispose()

      const md = isMarkdownFile(openFile)
      fileToolbar.hidden = !md
      if (md && openFile.path !== lastMarkdownPath) {
        markdownViewMode = 'preview'
        lastMarkdownPath = openFile.path
      }
      if (!md) lastMarkdownPath = null

      if (md && markdownViewMode === 'preview') {
        renderMarkdownPreview(openFile.content)
        previewContainer.hidden = false
        fileContainer.hidden = true
      } else {
        previewContainer.hidden = true
        fileContainer.hidden = false
      }
      syncToolbarActive()
    } else if (panelTab === 'diff' && activeDiff) {
      emptyContainer.hidden = true
      fileContainer.hidden = true
      diffContainer.hidden = false
      const oldModels = diffEditor.getModel()
      diffEditor.setModel({
        original: monaco.editor.createModel(activeDiff.before, activeDiff.language),
        modified: monaco.editor.createModel(activeDiff.after, activeDiff.language),
      })
      oldModels?.original.dispose()
      oldModels?.modified.dispose()
      acceptBtn.onclick = () => {
        if (!activeDiff) return
        void api.diff.approve(activeDiff.path)
      }
      rejectBtn.onclick = () => void api.diff.reject(activeDiff.path)
    } else {
      fileToolbar.hidden = true
      previewContainer.hidden = true
      fileContainer.hidden = true
      diffContainer.hidden = true
      emptyContainer.hidden = false
    }
  }

  let watchedPath: string | null = null

  const unsubs = [
    store.on('panel_changed', () => {
      updatePanel()
      const { openFile } = store.getState()
      if (watchedPath && watchedPath !== openFile?.path) {
        void api.fs.unwatch(watchedPath)
        watchedPath = null
      }
      if (openFile && watchedPath !== openFile.path) {
        void api.fs.watch(openFile.path)
        watchedPath = openFile.path
      }
    }),
    store.on('theme_changed', (theme) => {
      monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
    }),
    store.on('staged_diffs_changed', () => updatePanel()),
  ]

  const unsubFsChanged = api.fs.onChanged((path, newContent) => {
    if (path !== store.getState().openFile?.path) return
    void (async () => {
      let content: string
      try {
        content = newContent ?? (await api.fs.readFile(path))
      } catch (err) {
        showErrorToast(`Failed to reload ${path}`, err)
        return
      }
      const model = fileEditor.getModel()
      if (model && !model.isDisposed() && !fileEditor.hasTextFocus()) {
        model.setValue(content)
      }
      if (markdownViewMode === 'preview' && !previewContainer.hidden) {
        renderMarkdownPreview(content)
      }
    })()
  })

  updatePanel()

  const unbindDrop = bindFileDropTarget(
    root,
    getPromptAttachmentHandlers,
    api,
    () => store.getState().workspaceRoot,
  )
  const unbindFileLinks = bindFileReferenceClicks(previewContainer, store, api)

  return () => {
    unsubs.forEach((u) => u())
    unsubFsChanged()
    unbindDrop()
    unbindFileLinks()
    fileEditor.dispose()
    diffEditor.dispose()
  }
}
