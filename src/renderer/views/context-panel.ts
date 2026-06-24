import type * as Monaco from 'monaco-editor'
import type { AppStore } from '@shared/store/store.ts'
import type { OpenFile } from '@shared/types'
import type { ActiveDiff } from '@shared/types/state.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { pruneStagedDiffCache, resolveStagedDiffView } from '@shared/diff/staged-diff-ui.ts'
import { attachCodeBlockCopyButtons } from '../markdown/code-block-copy.ts'
import { renderMarkdown } from '../markdown/renderer.ts'
import { sanitizeRenderedMarkdown } from '../markdown/sanitize.ts'
import { renderMermaidIn } from '../markdown/mermaid.ts'
import { annotateFileReferences, bindFileReferenceClicks } from '../markdown/file-links.ts'
import { bindBrowserLinkClicks } from '../markdown/browser-links.ts'
import { bindFileDropTarget } from '../attachments/handle-file-drop.ts'
import { getPromptAttachmentHandlers } from '../attachments/prompt-attachments.ts'
import { revealFirstDiffChangeOnNextUpdate } from '../monaco/diff-scroll.ts'
import { disposeDiffModels } from '../monaco/git-diff-viewer.ts'
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

  const diffStage = document.createElement('div')
  diffStage.className = 'diff-stage'
  diffStage.hidden = true
  const diffToolbar = document.createElement('div')
  diffToolbar.className = 'diff-stage-toolbar'
  diffToolbar.hidden = true
  const conflictBanner = document.createElement('div')
  conflictBanner.className = 'diff-conflict-banner'
  conflictBanner.hidden = true
  const acceptAllBtn = document.createElement('button')
  acceptAllBtn.type = 'button'
  acceptAllBtn.textContent = 'Accept all'
  const rejectAllBtn = document.createElement('button')
  rejectAllBtn.type = 'button'
  rejectAllBtn.textContent = 'Reject all'
  diffToolbar.append(acceptAllBtn, rejectAllBtn)

  const diffBody = document.createElement('div')
  diffBody.className = 'diff-stage-body'
  const diffFileList = document.createElement('div')
  diffFileList.className = 'diff-file-list'
  diffFileList.hidden = true
  const diffContainer = document.createElement('div')
  diffContainer.className = 'monaco-container diff-container'
  diffBody.append(diffFileList, diffContainer)
  diffStage.append(conflictBanner, diffToolbar, diffBody)
  const emptyContainer = document.createElement('div')
  emptyContainer.className = 'panel-empty'
  emptyContainer.textContent = 'Open a file or run a task to see content here'

  root.append(fileToolbar, previewContainer, fileContainer, diffStage, emptyContainer)

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

  acceptAllBtn.addEventListener('click', () => void api.diff.approveAll())
  rejectAllBtn.addEventListener('click', () => void api.diff.rejectAll())

  const diffCache = new Map<string, ActiveDiff>()
  let selectedDiffPath: string | null = null
  let cancelPendingDiffReveal: (() => void) | null = null
  let currentDiffView: ActiveDiff | null = null

  api.diff.onShowDiff((path, before, after, language) => {
    diffCache.set(path, { path, before, after, language })
  })

  function renderDiffFileList(entries: { path: string }[], highlightPath: string) {
    diffFileList.replaceChildren()
    const seen = new Set<string>()
    const unique: { path: string }[] = []
    for (const entry of entries) {
      if (seen.has(entry.path)) continue
      seen.add(entry.path)
      unique.push(entry)
    }
    const multi = unique.length > 1
    diffFileList.hidden = !multi
    diffToolbar.hidden = !multi
    if (!multi) return
    for (const entry of unique) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `diff-file-btn${entry.path === highlightPath ? ' selected' : ''}`
      btn.textContent = entry.path
      btn.addEventListener('click', () => {
        selectedDiffPath = entry.path
        store.emit('panel_changed')
      })
      diffFileList.append(btn)
    }
  }

  function clearDiffView() {
    cancelPendingDiffReveal?.()
    cancelPendingDiffReveal = null
    currentDiffView = null
    disposeDiffModels(diffEditor)
  }

  function showDiffView(view: ActiveDiff) {
    cancelPendingDiffReveal?.()
    cancelPendingDiffReveal = null
    currentDiffView = view
    const oldModels = diffEditor.getModel()
    diffEditor.setModel(null)
    oldModels?.original.dispose()
    oldModels?.modified.dispose()
    diffEditor.setModel({
      original: monaco.editor.createModel(view.before, view.language),
      modified: monaco.editor.createModel(view.after, view.language),
    })
    cancelPendingDiffReveal = revealFirstDiffChangeOnNextUpdate(diffEditor)
    acceptBtn.onclick = () => void api.diff.approve(view.path)
    rejectBtn.onclick = () => void api.diff.reject(view.path)
  }

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
  registerMonacoSelectionToChatShortcut(diffEditor.getOriginalEditor(), monaco, () =>
    currentDiffView ? { path: currentDiffView.path, detail: 'before' } : null,
  )
  registerMonacoSelectionToChatShortcut(diffEditor.getModifiedEditor(), monaco, () =>
    currentDiffView ? { path: currentDiffView.path, detail: 'after' } : null,
  )

  function updatePanel() {
    const { openFile, activeDiff, panelTab, stagedDiffs } = store.getState()
    const queue = stagedDiffs ?? []
    if (queue.length === 0) conflictBanner.hidden = true

    if (queue.length > 0 && panelTab !== 'diff') {
      store.setState({ panelTab: 'diff' })
      store.emit('panel_changed')
      return
    }

    if (panelTab === 'file' && openFile) {
      emptyContainer.hidden = true
      diffStage.hidden = true
      clearDiffView()

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
    } else if (panelTab === 'diff') {
      pruneStagedDiffCache(diffCache, queue)
      if (activeDiff) diffCache.set(activeDiff.path, activeDiff)
      if (selectedDiffPath && !queue.some((e) => e.path === selectedDiffPath)) {
        selectedDiffPath = null
      }
      const view = resolveStagedDiffView(queue, diffCache, selectedDiffPath, activeDiff)
      if (view) {
        emptyContainer.hidden = true
        fileToolbar.hidden = true
        previewContainer.hidden = true
        fileContainer.hidden = true
        diffStage.hidden = false
        renderDiffFileList(queue, view.path)
        showDiffView(view)
      } else {
        selectedDiffPath = null
        fileToolbar.hidden = true
        previewContainer.hidden = true
        fileContainer.hidden = true
        diffStage.hidden = true
        clearDiffView()
        emptyContainer.hidden = false
      }
    } else {
      fileToolbar.hidden = true
      previewContainer.hidden = true
      fileContainer.hidden = true
      diffStage.hidden = true
      clearDiffView()
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

  const unsubDiffConflict = api.diff.onConflict((paths) => {
    conflictBanner.hidden = false
    conflictBanner.textContent =
      paths.length === 1
        ? `${paths[0]} changed on disk since this diff was staged. The diff was refreshed against the current file — review and re-approve to keep your changes.`
        : `${paths.length} files changed on disk since they were staged. Their diffs were refreshed against the current files — review and re-approve.`
    if (paths[0]) {
      selectedDiffPath = paths[0]
      store.setState({ panelTab: 'diff', rightPanelMode: 'explorer', filesPaneOpen: true })
      store.emit('panel_changed')
      store.emit('right_panel_mode_changed')
      store.emit('files_pane_changed')
    }
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
    cancelPendingDiffReveal?.()
    unsubFsChanged()
    unsubDiffConflict()
    unbindDrop()
    unbindFileLinks()
    unbindBrowserLinks()
    fileEditor.dispose()
    diffEditor.dispose()
  }
}
