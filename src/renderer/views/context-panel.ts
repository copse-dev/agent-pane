import type * as Monaco from 'monaco-editor'
import type { AppStore } from '@shared/store/store.ts'
import type { OpenFile } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { attachCodeBlockCopyButtons } from '../markdown/code-block-copy.ts'
import { renderMarkdown } from '../markdown/renderer.ts'
import { sanitizeRenderedMarkdown } from '../markdown/sanitize.ts'
import { renderMermaidIn } from '../markdown/mermaid.ts'
import { annotateFileReferences, bindFileReferenceClicks } from '../markdown/file-links.ts'
import { bindBrowserLinkClicks } from '../markdown/browser-links.ts'
import { bindFileDropTarget } from '../attachments/handle-file-drop.ts'
import { getPromptAttachmentHandlers } from '../attachments/prompt-attachments.ts'
import { registerMonacoSelectionToChatShortcut } from '../monaco/selection-to-chat.ts'
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

  const emptyContainer = document.createElement('div')
  emptyContainer.className = 'panel-empty'
  emptyContainer.textContent = 'Open a file or run a task to see content here'

  root.append(fileToolbar, previewContainer, fileContainer, emptyContainer)

  let markdownViewMode: MarkdownViewMode = 'preview'
  let lastMarkdownPath: string | null = null

  function syncToolbarActive() {
    previewBtn.classList.toggle('is-active', markdownViewMode === 'preview')
    sourceBtn.classList.toggle('is-active', markdownViewMode === 'source')
  }

  function renderMarkdownPreview(content: string): void {
    previewContainer.innerHTML = sanitizeRenderedMarkdown(renderMarkdown(content))
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

  fileEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    const { openFile } = store.getState()
    if (openFile) {
      void api.fs.writeFile(openFile.path, fileEditor.getValue()).catch((err) => {
        showErrorToast(`Failed to save ${openFile.path}`, err)
      })
    }
  })

  registerMonacoSelectionToChatShortcut(fileEditor, monaco, () => {
    const { openFile } = store.getState()
    return openFile ? { path: openFile.path } : null
  })

  function updatePanel() {
    const { openFile } = store.getState()

    if (openFile) {
      emptyContainer.hidden = true

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
    } else {
      fileToolbar.hidden = true
      previewContainer.hidden = true
      fileContainer.hidden = true
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
  const unbindBrowserLinks = bindBrowserLinkClicks(previewContainer, store, api)

  return () => {
    unsubs.forEach((u) => u())
    unsubFsChanged()
    unbindDrop()
    unbindFileLinks()
    unbindBrowserLinks()
    fileEditor.dispose()
  }
}
