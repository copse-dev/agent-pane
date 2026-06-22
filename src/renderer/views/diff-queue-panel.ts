import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type * as Monaco from 'monaco-editor'
import { clear } from '../dom/helpers.ts'

export function mountDiffQueuePanel(
  root: HTMLElement,
  store: AppStore,
  api: ApiClient,
  monaco: typeof Monaco,
): () => void {
  const fileList = document.createElement('div')
  fileList.className = 'diff-file-list'
  const editorWrap = document.createElement('div')
  editorWrap.className = 'diff-editor-wrap'
  const toolbar = document.createElement('div')
  toolbar.className = 'diff-queue-toolbar'
  const acceptAllBtn = document.createElement('button')
  acceptAllBtn.textContent = 'Accept all ✓'
  const rejectAllBtn = document.createElement('button')
  rejectAllBtn.textContent = 'Reject all ✕'
  const acceptBtn = document.createElement('button')
  acceptBtn.textContent = 'Accept ✓'
  acceptBtn.className = 'diff-accept-btn'
  const rejectBtn = document.createElement('button')
  rejectBtn.textContent = 'Reject ✕'
  rejectBtn.className = 'diff-reject-btn'

  const conflictBanner = document.createElement('div')
  conflictBanner.className = 'diff-conflict-banner'
  conflictBanner.hidden = true

  toolbar.append(acceptAllBtn, rejectAllBtn)
  root.append(toolbar, conflictBanner, fileList, editorWrap, acceptBtn, rejectBtn)

  const diffEditor = monaco.editor.createDiffEditor(editorWrap, {
    readOnly: true,
    automaticLayout: true,
    theme: store.getState().theme === 'dark' ? 'vs-dark' : 'vs',
  })

  let selectedPath: string | null = null

  function renderFileList() {
    clear(fileList)
    const { stagedDiffs } = store.getState()
    stagedDiffs.forEach((entry) => {
      const btn = document.createElement('button')
      btn.className = `diff-file-btn${entry.path === selectedPath ? ' selected' : ''}`
      btn.textContent = entry.path
      btn.addEventListener('click', () => selectDiff(entry.path))
      fileList.append(btn)
    })
    if (stagedDiffs.length > 0 && !selectedPath) {
      selectDiff(stagedDiffs[0]!.path)
    }
  }

  function selectDiff(path: string) {
    selectedPath = path
    renderFileList()
    // The diff data came via agent:show_diff IPC — stored in memory here
    const entry = diffData.get(path)
    if (!entry) return
    const oldModels = diffEditor.getModel()
    diffEditor.setModel({
      original: monaco.editor.createModel(entry.before, entry.language),
      modified: monaco.editor.createModel(entry.after, entry.language),
    })
    oldModels?.original.dispose()
    oldModels?.modified.dispose()
    acceptBtn.onclick = () => void api.diff.approve(path)
    rejectBtn.onclick = () => void api.diff.reject(path)
  }

  // Store diff data as it arrives from main
  const diffData = new Map<string, { before: string; after: string; language: string }>()
  const unsubShowDiff = api.diff.onShowDiff((path, before, after, language) => {
    diffData.set(path, { before, after, language })
    // A re-staged diff (e.g. after a conflict) must refresh the visible editor.
    if (path === selectedPath) selectDiff(path)
  })
  const unsubConflict = api.diff.onConflict((paths) => {
    conflictBanner.hidden = false
    conflictBanner.textContent =
      paths.length === 1
        ? `${paths[0]} changed on disk since this diff was staged. The diff was refreshed against the current file — review and re-approve to keep your changes.`
        : `${paths.length} files changed on disk since they were staged. Their diffs were refreshed against the current files — review and re-approve.`
    // Surface a refreshed file so the user lands on a conflicting diff.
    if (paths[0]) selectDiff(paths[0])
  })
  const unsubQueued = api.diff.onQueued((entries) => {
    // Remove entries that are no longer in the queue
    for (const key of diffData.keys()) {
      if (!entries.find((e) => e.path === key)) diffData.delete(key)
    }
    if (entries.length === 0) conflictBanner.hidden = true
    store.setState({ stagedDiffs: entries })
    store.emit('staged_diffs_changed')
    renderFileList()
  })

  acceptAllBtn.addEventListener('click', () => void api.diff.approveAll())
  rejectAllBtn.addEventListener('click', () => void api.diff.rejectAll())

  const unsub = store.on('staged_diffs_changed', renderFileList)
  renderFileList()

  return () => {
    unsub()
    unsubShowDiff()
    unsubConflict()
    unsubQueued()
    diffEditor.dispose()
  }
}
