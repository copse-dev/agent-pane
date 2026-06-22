import type * as Monaco from 'monaco-editor'
import { el, clear } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GitChange, GitChangeStatus, GitFileDiff, GitStatusResult } from '@shared/types/git.ts'
import {
  createGitChangesDiffEditor,
  disposeDiffModels,
  observeDiffHostLayout,
  setGitFileDiffModel,
} from '../monaco/git-diff-viewer.ts'
import { attachMonacoSelectionToChat } from '../monaco/selection-to-chat.ts'

function isImageDiff(diff: GitFileDiff): boolean {
  return diff.beforeImage != null || diff.afterImage != null
}

function renderImageDiff(container: HTMLElement, diff: GitFileDiff): void {
  clear(container)
  const grid = el('div', { class: 'git-image-diff' })

  if (diff.beforeImage) {
    const pane = el('div', { class: 'git-image-diff-pane' })
    pane.append(
      el('div', { class: 'git-image-diff-label' }, 'Before'),
      el('img', {
        class: 'git-image-diff-img',
        src: diff.beforeImage,
        alt: `${diff.path} (before)`,
        loading: 'lazy',
      }),
    )
    grid.append(pane)
  }

  if (diff.afterImage) {
    const pane = el('div', { class: 'git-image-diff-pane' })
    pane.append(
      el('div', { class: 'git-image-diff-label' }, 'After'),
      el('img', {
        class: 'git-image-diff-img',
        src: diff.afterImage,
        alt: `${diff.path} (after)`,
        loading: 'lazy',
      }),
    )
    grid.append(pane)
  }

  if (!diff.beforeImage && !diff.afterImage) {
    grid.append(el('div', { class: 'panel-empty' }, 'Could not load image'))
  }

  container.append(grid)
}

const STATUS_LABEL: Record<GitChangeStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
}

function changesModeActive(store: AppStore): boolean {
  const { filesPaneOpen, rightPanelMode } = store.getState()
  return filesPaneOpen && rightPanelMode === 'changes'
}

function getFirstChange(status: GitStatusResult): { path: string; staged: boolean } | null {
  const staged = status.staged[0]
  if (staged) return { path: staged.path, staged: true }
  const unstaged = status.unstaged[0]
  if (unstaged) return { path: unstaged.path, staged: false }
  return null
}

export function mountGitChangesPane(
  listRoot: HTMLElement,
  viewerRoot: HTMLElement,
  store: AppStore,
  api: ApiClient,
  monaco: typeof Monaco,
): () => void {
  const listHeader = el('div', { class: 'git-changes-header' })
  const headerTitle = el('span', { class: 'git-changes-title' }, 'Changes')
  const refreshBtn = el(
    'button',
    {
      type: 'button',
      class: 'git-changes-refresh-btn',
      'aria-label': 'Refresh changes',
      title: 'Refresh',
    },
    '↻',
  )
  listHeader.append(headerTitle, refreshBtn)

  const listBody = el('div', { class: 'git-changes-list' })
  listRoot.append(listHeader, listBody)

  const diffWrap = el('div', { class: 'git-diff-editor-wrap' })
  const imageWrap = el('div', { class: 'git-image-diff-wrap' })
  const emptyState = el('div', { class: 'panel-empty' }, 'Select a changed file')
  viewerRoot.append(diffWrap, imageWrap, emptyState)

  let diffEditor: Monaco.editor.IStandaloneDiffEditor | null = null
  let pendingSelect: { path: string; staged: boolean } | null = null
  let selectRequestId = 0
  let diffLoadQueue: Promise<void> = Promise.resolve()
  let status: GitStatusResult | null = null
  let gitAvailable = false
  let selected: { path: string; staged: boolean } | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null

  function ensureDiffEditor(): Monaco.editor.IStandaloneDiffEditor {
    if (!diffEditor) {
      const theme = store.getState().theme === 'dark' ? 'vs-dark' : 'vs'
      diffEditor = createGitChangesDiffEditor(diffWrap, monaco, store.getState().fontSize, theme)
      diffEditor.getOriginalEditor().addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => {
        const path = selected?.path
        if (path) attachMonacoSelectionToChat(diffEditor!.getOriginalEditor(), path, 'before')
      })
      diffEditor.getModifiedEditor().addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => {
        const path = selected?.path
        if (path) attachMonacoSelectionToChat(diffEditor!.getModifiedEditor(), path, 'after')
      })
    }
    return diffEditor
  }

  function renderSection(title: string, changes: GitChange[], staged: boolean) {
    if (changes.length === 0) return
    const section = el('div', { class: 'git-changes-section' })
    section.append(
      el('div', { class: 'git-changes-section-title' }, `${title} (${changes.length})`),
    )
    for (const change of changes) {
      const isSelected = selected?.path === change.path && selected.staged === staged
      const row = el(
        'button',
        {
          type: 'button',
          class: `git-change-row${isSelected ? ' is-selected' : ''}`,
        },
        el(
          'span',
          { class: `git-change-status git-change-status-${change.status}` },
          STATUS_LABEL[change.status],
        ),
        el('span', { class: 'git-change-path' }, change.path),
      )
      row.addEventListener('click', () => void selectChange(change.path, staged))
      section.append(row)
    }
    listBody.append(section)
  }

  function renderList() {
    clear(listBody)
    if (!gitAvailable) {
      listBody.append(el('div', { class: 'git-changes-empty' }, 'Not a git repository'))
      return
    }
    if (!status || (status.staged.length === 0 && status.unstaged.length === 0)) {
      listBody.append(el('div', { class: 'git-changes-empty' }, 'No changes'))
      return
    }
    renderSection('Staged', status.staged, true)
    renderSection('Unstaged', status.unstaged, false)
  }

  async function selectChange(path: string, staged: boolean) {
    const requestId = ++selectRequestId
    selected = { path, staged }
    pendingSelect = { path, staged }
    renderList()
    const diff = await api.git.fileDiff(path, staged)
    if (
      requestId !== selectRequestId ||
      pendingSelect?.path !== path ||
      pendingSelect.staged !== staged
    ) {
      return
    }
    if (!diff) {
      emptyState.hidden = false
      diffWrap.hidden = true
      imageWrap.hidden = true
      emptyState.textContent = 'Could not load diff'
      return
    }
    diffLoadQueue = diffLoadQueue
      .catch(() => undefined)
      .then(async () => {
        if (
          requestId !== selectRequestId ||
          pendingSelect?.path !== path ||
          pendingSelect.staged !== staged
        ) {
          return
        }
        emptyState.hidden = true
        if (isImageDiff(diff)) {
          diffWrap.hidden = true
          imageWrap.hidden = false
          if (diffEditor) disposeDiffModels(diffEditor)
          renderImageDiff(imageWrap, diff)
          return
        }
        imageWrap.hidden = true
        diffWrap.hidden = false
        await setGitFileDiffModel(ensureDiffEditor(), monaco, diff, viewerRoot)
      })
    await diffLoadQueue
  }

  function clearSelection() {
    selectRequestId++
    selected = null
    pendingSelect = null
    emptyState.hidden = false
    emptyState.textContent = 'Select a changed file'
    diffWrap.hidden = true
    imageWrap.hidden = true
    clear(imageWrap)
    const editor = diffEditor
    if (!editor) return
    disposeDiffModels(editor)
  }

  async function refresh() {
    gitAvailable = await api.git.isAvailable()
    if (!gitAvailable) {
      status = null
      clearSelection()
      renderList()
      return
    }
    status = await api.git.status()
    const current = selected
    if (current) {
      const stillExists = current.staged
        ? status?.staged.some((c) => c.path === current.path)
        : status?.unstaged.some((c) => c.path === current.path)
      if (!stillExists) clearSelection()
    }
    renderList()
    if (selected) {
      await selectChange(selected.path, selected.staged)
    } else {
      const first = status ? getFirstChange(status) : null
      if (first) await selectChange(first.path, first.staged)
    }
  }

  function scheduleRefresh() {
    if (!changesModeActive(store)) return
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => void refresh(), 500)
  }

  refreshBtn.addEventListener('click', () => void refresh())

  const stopObservingLayout = observeDiffHostLayout(viewerRoot, () => diffEditor)

  const unsubs = [
    store.on('right_panel_mode_changed', () => {
      if (changesModeActive(store)) void refresh()
    }),
    store.on('files_pane_changed', () => {
      if (changesModeActive(store)) void refresh()
    }),
    store.on('workspace_changed', () => {
      status = null
      clearSelection()
      if (changesModeActive(store)) void refresh()
      else renderList()
    }),
    store.on('theme_changed', (theme) => {
      monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
    }),
    api.fs.onChanged(() => scheduleRefresh()),
  ]

  renderList()
  clearSelection()

  return () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    stopObservingLayout()
    unsubs.forEach((u) => u())
    diffEditor?.dispose()
    diffEditor = null
  }
}
