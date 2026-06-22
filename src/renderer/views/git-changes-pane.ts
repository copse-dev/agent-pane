import type * as Monaco from 'monaco-editor'
import { el, clear } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GitChange, GitChangeStatus, GitFileDiff, GitStatusResult } from '@shared/types/git.ts'
import { revealFirstDiffChangeOnNextUpdate } from '../monaco/diff-scroll.ts'

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

  const diffEditor = monaco.editor.createDiffEditor(diffWrap, {
    readOnly: true,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    fontSize: store.getState().fontSize,
    theme: store.getState().theme === 'dark' ? 'vs-dark' : 'vs',
    hideUnchangedRegions: {
      enabled: true,
      contextLineCount: 3,
      minimumLineCount: 3,
      revealLineCount: 20,
    },
  })

  let status: GitStatusResult | null = null
  let gitAvailable = false
  let selected: { path: string; staged: boolean } | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let cancelPendingDiffReveal: (() => void) | null = null

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
    selected = { path, staged }
    renderList()
    const diff = await api.git.fileDiff(path, staged)
    if (!diff) {
      emptyState.hidden = false
      diffWrap.hidden = true
      imageWrap.hidden = true
      emptyState.textContent = 'Could not load diff'
      return
    }
    emptyState.hidden = true
    if (isImageDiff(diff)) {
      diffWrap.hidden = true
      imageWrap.hidden = false
      cancelPendingDiffReveal?.()
      cancelPendingDiffReveal = null
      const oldModels = diffEditor.getModel()
      if (oldModels?.original) oldModels.original.dispose()
      if (oldModels?.modified) oldModels.modified.dispose()
      renderImageDiff(imageWrap, diff)
      return
    }
    imageWrap.hidden = true
    diffWrap.hidden = false
    const oldModels = diffEditor.getModel()
    cancelPendingDiffReveal?.()
    cancelPendingDiffReveal = revealFirstDiffChangeOnNextUpdate(diffEditor)
    diffEditor.setModel({
      original: monaco.editor.createModel(diff.before, diff.language),
      modified: monaco.editor.createModel(diff.after, diff.language),
    })
    oldModels?.original.dispose()
    oldModels?.modified.dispose()
    await new Promise<void>((resolve) => {
      const disposable = diffEditor.onDidUpdateDiff(() => {
        disposable.dispose()
        resolve()
      })
    })
    diffEditor.layout()
  }

  function clearSelection() {
    selected = null
    emptyState.hidden = false
    emptyState.textContent = 'Select a changed file'
    diffWrap.hidden = true
    imageWrap.hidden = true
    clear(imageWrap)
    cancelPendingDiffReveal?.()
    cancelPendingDiffReveal = null
    const oldModels = diffEditor.getModel()
    if (oldModels?.original) oldModels.original.dispose()
    if (oldModels?.modified) oldModels.modified.dispose()
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
    unsubs.forEach((u) => u())
    cancelPendingDiffReveal?.()
    diffEditor.dispose()
  }
}
