import type * as Monaco from 'monaco-editor'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'

export function mountContextPanel(
  root: HTMLElement,
  store: AppStore,
  api: ApiClient,
  monaco: typeof Monaco,
): () => void {
  const fileContainer = document.createElement('div')
  fileContainer.className = 'monaco-container'
  const diffContainer = document.createElement('div')
  diffContainer.className = 'monaco-container diff-container'
  const emptyContainer = document.createElement('div')
  emptyContainer.className = 'panel-empty'
  emptyContainer.textContent = 'Open a file or run a task to see content here'

  root.append(fileContainer, diffContainer, emptyContainer)

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
    if (openFile) void api.fs.writeFile(openFile.path, fileEditor.getValue())
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
      fileContainer.hidden = false
      const old = fileEditor.getModel()
      fileEditor.setModel(monaco.editor.createModel(openFile.content, openFile.language))
      old?.dispose()
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
      acceptBtn.onclick = () => void api.diff.approve(activeDiff.path)
      rejectBtn.onclick = () => void api.diff.reject(activeDiff.path)
    } else {
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

  api.fs.onChanged((path, newContent) => {
    if (path !== store.getState().openFile?.path) return
    const model = fileEditor.getModel()
    if (model && !model.isDisposed() && !fileEditor.hasTextFocus()) {
      model.setValue(newContent)
    }
  })

  updatePanel()
  return () => {
    unsubs.forEach((u) => u())
    fileEditor.dispose()
    diffEditor.dispose()
  }
}
