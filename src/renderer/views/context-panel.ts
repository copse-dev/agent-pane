import type * as Monaco from 'monaco-editor'
import type { AppStore } from '@shared/store/store.ts'
import type { OpenFile } from '@shared/types'
import type { GitFileDiff } from '@shared/types/git.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { attachCodeBlockCopyButtons } from '../markdown/code-block-copy.ts'
import { renderMarkdown } from '@copse/streaming-markdown'
import { renderMermaidIn } from '../markdown/mermaid.ts'
import { annotateFileReferences, bindFileReferenceClicks } from '../markdown/file-links.ts'
import { bindBrowserLinkClicks } from '../markdown/browser-links.ts'
import { bindWorkspaceLinkClicks } from '../markdown/workspace-links.ts'
import { bindFileDropTarget } from '../attachments/handle-file-drop.ts'
import { getPromptAttachmentHandlers } from '../attachments/prompt-attachments.ts'
import { registerMonacoSelectionToChatShortcut } from '../monaco/selection-to-chat.ts'
import {
  createGitChangesDiffEditor,
  setGitFileDiffModel,
  type GitDiffMonaco,
  type GitDiffEditor,
  type GitDiffModel,
} from '../monaco/git-diff-viewer.ts'
import type { MonacoSelectionSource, MonacoShortcutSource } from '../monaco/selection-to-chat.ts'
import { showErrorToast } from './toast.ts'
import { showContextMenu } from '../dom/context-menu.ts'
import { scaledEditorFontSize } from '@shared/ui-scale.ts'
import { canOpenWorkspaceFileInBrowser, openWorkspaceFileInBrowser } from '../controller/files.ts'
import {
  getActiveThreadOwner,
  requireActiveThreadOwner,
} from '../controller/active-thread-owner.ts'

type FileViewMode = 'preview' | 'source' | 'changes'

export interface ContextPanelModel extends GitDiffModel {
  getValue(): string
  getValueInRange(range: NonNullable<ReturnType<MonacoSelectionSource['getSelection']>>): string
  isDisposed(): boolean
  setValue(value: string): void
}

export interface ContextPanelEditor extends MonacoShortcutSource {
  addCommand(keybinding: number, handler: () => void): void
  dispose(): void
  getModel(): ContextPanelModel | null
  getValue(): string
  hasTextFocus(): boolean
  layout(): void
  revealLineInCenter(line: number): void
  revealLineInCenterIfOutsideViewport(line: number): void
  setModel(model: ContextPanelModel | null): void
  setPosition(position: { lineNumber: number; column: number }): void
}

export interface ContextPanelMonaco extends GitDiffMonaco {
  editor: {
    create(
      container: HTMLElement,
      options: Monaco.editor.IStandaloneEditorConstructionOptions,
    ): ContextPanelEditor
    createDiffEditor(
      container: HTMLElement,
      options: Monaco.editor.IStandaloneDiffEditorConstructionOptions,
    ): GitDiffEditor
    createModel(value: string, language?: string, uri?: { toString(): string }): ContextPanelModel
    setTheme(theme: string): void
  }
  KeyCode: { KeyL: number; KeyS: number }
  KeyMod: { CtrlCmd: number }
}

function isMarkdownFile(openFile: OpenFile): boolean {
  if (openFile.language === 'markdown') return true
  const name = openFile.path.split('/').pop()?.toLowerCase() ?? ''
  return name.endsWith('.md') || name.endsWith('.mdx')
}

export function mountContextPanel(
  root: HTMLElement,
  store: AppStore,
  api: ApiClient,
  monaco: ContextPanelMonaco,
): () => void {
  const fileToolbar = document.createElement('div')
  fileToolbar.className = 'file-viewer-toolbar'
  fileToolbar.hidden = true
  const previewBtn = document.createElement('button')
  previewBtn.type = 'button'
  previewBtn.className = 'file-viewer-preview-btn'
  previewBtn.textContent = 'Preview'
  const sourceBtn = document.createElement('button')
  sourceBtn.type = 'button'
  sourceBtn.className = 'file-viewer-source-btn'
  sourceBtn.textContent = 'Edit source'
  const changesBtn = document.createElement('button')
  changesBtn.type = 'button'
  changesBtn.className = 'file-viewer-changes-btn'
  changesBtn.textContent = 'Changes'
  changesBtn.hidden = true
  fileToolbar.append(previewBtn, sourceBtn, changesBtn)

  const previewContainer = document.createElement('div')
  previewContainer.className = 'markdown-file-preview message-text streaming-markdown'
  previewContainer.hidden = true

  const fileContainer = document.createElement('div')
  fileContainer.className = 'monaco-container'

  const diffContainer = document.createElement('div')
  diffContainer.className = 'git-diff-editor-wrap file-viewer-diff'
  diffContainer.hidden = true

  const emptyContainer = document.createElement('div')
  emptyContainer.className = 'panel-empty'
  emptyContainer.textContent = 'Open a file or run a task to see content here'

  root.append(fileToolbar, previewContainer, fileContainer, diffContainer, emptyContainer)

  let viewMode: FileViewMode = 'source'
  let lastPath: string | null = null
  let revealedFor: OpenFile | null = null

  // Uncommitted (HEAD → working tree) changes for the open file, fetched
  // asynchronously; null while the file is clean or outside a git repo.
  let workingDiff: GitFileDiff | null = null
  let workingDiffRequestId = 0
  let diffEditor: GitDiffEditor | null = null
  // The diff attached to (or queued for) the diff editor, for render dedupe.
  let renderedDiff: GitFileDiff | null = null
  let queuedDiff: GitFileDiff | null = null
  let diffRenderChain: Promise<void> = Promise.resolve()

  function fallbackMode(md: boolean): FileViewMode {
    return md ? 'preview' : 'source'
  }

  function renderMarkdownPreview(content: string): void {
    previewContainer.innerHTML = renderMarkdown(content)
    attachCodeBlockCopyButtons(previewContainer)
    void annotateFileReferences(previewContainer, api)
    void renderMermaidIn(previewContainer)
  }

  function queueDiffRender(diff: GitFileDiff): void {
    if (queuedDiff === diff || renderedDiff === diff) return
    queuedDiff = diff
    diffRenderChain = diffRenderChain
      .catch(() => undefined)
      .then(async () => {
        if (queuedDiff !== diff) return
        if (viewMode !== 'changes' || store.getState().openFile?.path !== diff.path) {
          // Conditions changed while queued; allow a later re-queue.
          queuedDiff = null
          return
        }
        if (!diffEditor) {
          const created = createGitChangesDiffEditor(
            diffContainer,
            monaco,
            scaledEditorFontSize(store.getState().fontSize, store.getState().uiScale),
            store.getState().theme === 'dark' ? 'vs-dark' : 'vs',
          )
          diffEditor = created
          registerMonacoSelectionToChatShortcut(created.getOriginalEditor(), monaco, () => {
            const { openFile } = store.getState()
            return openFile ? { path: openFile.path, detail: 'before' } : null
          })
          registerMonacoSelectionToChatShortcut(created.getModifiedEditor(), monaco, () => {
            const { openFile } = store.getState()
            return openFile ? { path: openFile.path, detail: 'after' } : null
          })
        }
        await setGitFileDiffModel(diffEditor, monaco, diff, diffContainer)
        renderedDiff = diff
      })
  }

  function syncView(md: boolean): void {
    const hasChanges = workingDiff != null
    fileToolbar.hidden = !md && !hasChanges
    previewBtn.hidden = !md
    changesBtn.hidden = !hasChanges
    sourceBtn.textContent = md ? 'Edit source' : 'Source'
    previewBtn.classList.toggle('is-active', viewMode === 'preview')
    sourceBtn.classList.toggle('is-active', viewMode === 'source')
    changesBtn.classList.toggle('is-active', viewMode === 'changes')

    previewContainer.hidden = viewMode !== 'preview'
    fileContainer.hidden = viewMode !== 'source'
    diffContainer.hidden = viewMode !== 'changes'
    if (viewMode === 'source') fileEditor.layout()
    if (viewMode === 'changes' && workingDiff) queueDiffRender(workingDiff)
  }

  /**
   * Re-check whether the open file differs from HEAD and sync the Changes
   * button / view. Runs on every open and on filesystem changes; a request id
   * guards against out-of-order responses when files are switched quickly.
   */
  async function refreshWorkingDiff(): Promise<void> {
    const { openFile } = store.getState()
    if (!openFile) return
    const owner = getActiveThreadOwner(store)
    if (!owner) return
    const requestId = ++workingDiffRequestId
    const diff = await api.git
      .workingFileDiff(owner.projectId, owner.threadId, openFile.path)
      .catch(() => null)
    if (requestId !== workingDiffRequestId) return
    const current = store.getState().openFile
    const currentOwner = getActiveThreadOwner(store)
    if (
      !current ||
      current.path !== openFile.path ||
      currentOwner?.projectId !== owner.projectId ||
      currentOwner.threadId !== owner.threadId
    )
      return

    // Identical content means nothing to re-render; keep the attached models
    // (and the user's diff scroll position) instead of churning them.
    if (
      workingDiff &&
      diff &&
      workingDiff.before === diff.before &&
      workingDiff.after === diff.after
    )
      return

    workingDiff = diff
    const md = isMarkdownFile(current)
    if (viewMode === 'changes' && !diff) {
      viewMode = fallbackMode(md)
      if (viewMode === 'preview') renderMarkdownPreview(current.content)
    }
    syncView(md)
  }

  previewBtn.addEventListener('click', () => {
    viewMode = 'preview'
    const model = fileEditor.getModel()
    if (model && !model.isDisposed()) {
      renderMarkdownPreview(model.getValue())
    }
    syncView(true)
  })

  sourceBtn.addEventListener('click', () => {
    const { openFile } = store.getState()
    if (!openFile) return
    viewMode = 'source'
    syncView(isMarkdownFile(openFile))
  })

  changesBtn.addEventListener('click', () => {
    const { openFile } = store.getState()
    if (!openFile || !workingDiff) return
    viewMode = 'changes'
    syncView(isMarkdownFile(openFile))
  })

  const fileEditor = monaco.editor.create(fileContainer, {
    readOnly: false,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    fontSize: scaledEditorFontSize(store.getState().fontSize, store.getState().uiScale),
    theme: store.getState().theme === 'dark' ? 'vs-dark' : 'vs',
  })

  fileEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    const { openFile } = store.getState()
    if (openFile) {
      const owner = requireActiveThreadOwner(store)
      void api.fs
        .writeFile(owner.projectId, owner.threadId, openFile.path, fileEditor.getValue())
        .catch((err: unknown) => {
          showErrorToast(`Failed to save ${openFile.path}`, err)
        })
    }
  })

  registerMonacoSelectionToChatShortcut(fileEditor, monaco, () => {
    const { openFile } = store.getState()
    return openFile ? { path: openFile.path } : null
  })

  const onContextMenu = (event: MouseEvent): void => {
    const { openFile } = store.getState()
    if (!openFile || !canOpenWorkspaceFileInBrowser(store)) return

    event.preventDefault()
    event.stopPropagation()
    showContextMenu(event.clientX, event.clientY, [
      {
        label: 'Open in browser',
        onSelect: (): void => {
          const currentOpenFile = store.getState().openFile
          if (!currentOpenFile) return
          void openWorkspaceFileInBrowser(store, api, currentOpenFile.path).catch(
            (err: unknown): void => {
              showErrorToast(`Failed to open ${currentOpenFile.path} in the browser`, err)
            },
          )
        },
      },
    ])
  }
  root.addEventListener('contextmenu', onContextMenu, true)

  function updatePanel(): void {
    const { openFile } = store.getState()

    if (openFile) {
      emptyContainer.hidden = true

      const old = fileEditor.getModel()
      fileEditor.setModel(monaco.editor.createModel(openFile.content, openFile.language))
      old?.dispose()

      // Reveal a requested line/col once per distinct open (a new openFile
      // object), so unrelated panel re-renders don't yank the user's scroll.
      if (openFile.reveal && revealedFor !== openFile) {
        const { line, column } = openFile.reveal
        fileEditor.revealLineInCenter(line)
        fileEditor.setPosition({ lineNumber: line, column: column ?? 1 })
      }
      revealedFor = openFile

      const md = isMarkdownFile(openFile)
      if (openFile.path !== lastPath) {
        lastPath = openFile.path
        viewMode = fallbackMode(md)
        // The previous file's diff must not leak onto this one; the async
        // refresh re-detects changes for the new path.
        workingDiff = null
      }
      if (viewMode === 'changes' && !workingDiff) viewMode = fallbackMode(md)

      if (viewMode === 'preview') renderMarkdownPreview(openFile.content)
      syncView(md)
    } else {
      lastPath = null
      workingDiff = null
      fileToolbar.hidden = true
      previewContainer.hidden = true
      fileContainer.hidden = true
      diffContainer.hidden = true
      emptyContainer.hidden = false
    }
  }

  let watched: { projectId: string; threadId: string; path: string } | null = null

  const unsubs = [
    store.on('panel_changed', () => {
      updatePanel()
      void refreshWorkingDiff()
      const { openFile } = store.getState()
      const owner = getActiveThreadOwner(store)
      if (
        watched &&
        (watched.path !== openFile?.path ||
          watched.projectId !== owner?.projectId ||
          watched.threadId !== owner.threadId)
      ) {
        void api.fs.unwatch(watched.projectId, watched.threadId, watched.path)
        watched = null
      }
      if (openFile && owner && !watched) {
        void api.fs.watch(owner.projectId, owner.threadId, openFile.path)
        watched = { ...owner, path: openFile.path }
      }
    }),
    store.on('theme_changed', (theme) => {
      monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
    }),
  ]

  const unsubFsChanged = api.fs.onChanged((projectId, threadId, path, newContent) => {
    const owner = getActiveThreadOwner(store)
    if (projectId !== owner?.projectId || threadId !== owner.threadId) return
    if (path !== store.getState().openFile?.path) return
    void (async (): Promise<void> => {
      let content: string
      try {
        content = newContent ?? (await api.fs.readFile(projectId, threadId, path))
      } catch (err) {
        showErrorToast(`Failed to reload ${path}`, err)
        return
      }
      const model = fileEditor.getModel()
      if (model && !model.isDisposed() && !fileEditor.hasTextFocus()) {
        model.setValue(content)
      }
      if (viewMode === 'preview' && !previewContainer.hidden) {
        renderMarkdownPreview(content)
      }
      await refreshWorkingDiff()
    })()
  })

  updatePanel()
  void refreshWorkingDiff()

  const unbindDrop = bindFileDropTarget(root, getPromptAttachmentHandlers, api, () => ({
    workspaceRoot: store.getState().workspaceRoot,
    owner: getActiveThreadOwner(store),
  }))
  const unbindFileLinks = bindFileReferenceClicks(previewContainer, store, api)
  const unbindWorkspaceLinks = bindWorkspaceLinkClicks(previewContainer, store, api)
  const unbindBrowserLinks = bindBrowserLinkClicks(previewContainer, store, api)

  return () => {
    unsubs.forEach((u) => {
      u()
    })
    unsubFsChanged()
    if (watched) void api.fs.unwatch(watched.projectId, watched.threadId, watched.path)
    unbindDrop()
    unbindFileLinks()
    unbindWorkspaceLinks()
    unbindBrowserLinks()
    root.removeEventListener('contextmenu', onContextMenu, true)
    fileEditor.dispose()
    diffEditor?.dispose()
    diffEditor = null
  }
}
