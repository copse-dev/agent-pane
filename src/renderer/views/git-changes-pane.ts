import type * as Monaco from 'monaco-editor'
import { el, clear } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GitChange, GitChangeStatus, GitFileDiff, GitStatusResult } from '@shared/types/git.ts'
import type { ActiveDiff } from '@shared/types/state.ts'
import { pruneStagedDiffCache, resolveStagedDiffView } from '@shared/diff/staged-diff-ui.ts'
import {
  createGitChangesDiffEditor,
  disposeDiffModels,
  observeDiffHostLayout,
  setGitFileDiffModel,
  whenDiffHostVisible,
} from '../monaco/git-diff-viewer.ts'
import {
  refreshGitChangesDiffCollapse,
  revealFirstDiffChange,
  revealFirstDiffChangeOnNextUpdate,
} from '../monaco/diff-scroll.ts'
import { registerMonacoSelectionToChatShortcut } from '../monaco/selection-to-chat.ts'

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

type ChangeSelection =
  | { kind: 'proposed'; path: string }
  | { kind: 'git'; path: string; staged: boolean }

function changesModeActive(store: AppStore): boolean {
  const { filesPaneOpen, rightPanelMode } = store.getState()
  return filesPaneOpen && rightPanelMode === 'changes'
}

function getFirstGitChange(status: GitStatusResult): { path: string; staged: boolean } | null {
  const staged = status.staged[0]
  if (staged) return { path: staged.path, staged: true }
  const unstaged = status.unstaged[0]
  if (unstaged) return { path: unstaged.path, staged: false }
  return null
}

function defaultProposedPath(
  queue: { path: string }[],
  activeDiff: ActiveDiff | null,
): string | null {
  if (queue.length === 0) return null
  if (activeDiff && queue.some((e) => e.path === activeDiff.path)) return activeDiff.path
  return queue[0]!.path
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
  const bulkActions = el('div', { class: 'git-changes-bulk-actions' })
  const acceptAllBtn = el('button', { type: 'button', class: 'git-changes-bulk-btn' }, 'Accept all')
  const rejectAllBtn = el('button', { type: 'button', class: 'git-changes-bulk-btn' }, 'Reject all')
  bulkActions.append(acceptAllBtn, rejectAllBtn)
  bulkActions.hidden = true
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
  listHeader.append(headerTitle, bulkActions, refreshBtn)

  const listBody = el('div', { class: 'git-changes-list' })
  listRoot.append(listHeader, listBody)

  const conflictBanner = el('div', { class: 'diff-conflict-banner' })
  conflictBanner.hidden = true
  const diffWrap = el('div', { class: 'git-diff-editor-wrap git-diff-editor-wrap-proposed' })
  const acceptBtn = el('button', { type: 'button', class: 'diff-accept-btn' }, 'Accept')
  const rejectBtn = el('button', { type: 'button', class: 'diff-reject-btn' }, 'Reject')
  acceptBtn.hidden = true
  rejectBtn.hidden = true
  diffWrap.append(acceptBtn, rejectBtn)
  const imageWrap = el('div', { class: 'git-image-diff-wrap' })
  const emptyState = el('div', { class: 'panel-empty' }, 'Select a changed file')
  viewerRoot.append(conflictBanner, diffWrap, imageWrap, emptyState)

  let diffEditor: Monaco.editor.IStandaloneDiffEditor | null = null
  let pendingSelect: ChangeSelection | null = null
  let selectRequestId = 0
  let diffLoadQueue: Promise<void> = Promise.resolve()
  let status: GitStatusResult | null = null
  let gitAvailable = false
  let selection: ChangeSelection | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let cancelPendingDiffReveal: (() => void) | null = null
  const proposedDiffCache = new Map<string, ActiveDiff>()

  acceptAllBtn.addEventListener('click', () => void api.diff.approveAll())
  rejectAllBtn.addEventListener('click', () => void api.diff.rejectAll())

  api.diff.onShowDiff((path, before, after, language) => {
    proposedDiffCache.set(path, { path, before, after, language })
    if (changesModeActive(store)) void syncFromStore()
  })

  function ensureDiffEditor(): Monaco.editor.IStandaloneDiffEditor {
    if (!diffEditor) {
      const theme = store.getState().theme === 'dark' ? 'vs-dark' : 'vs'
      diffEditor = createGitChangesDiffEditor(diffWrap, monaco, store.getState().fontSize, theme)
      registerMonacoSelectionToChatShortcut(diffEditor.getOriginalEditor(), monaco, () => {
        if (selection?.kind === 'proposed') {
          return { path: selection.path, detail: 'before' }
        }
        if (selection?.kind === 'git') {
          return { path: selection.path, detail: 'before' }
        }
        return null
      })
      registerMonacoSelectionToChatShortcut(diffEditor.getModifiedEditor(), monaco, () => {
        if (selection?.kind === 'proposed') {
          return { path: selection.path, detail: 'after' }
        }
        if (selection?.kind === 'git') {
          return { path: selection.path, detail: 'after' }
        }
        return null
      })
    }
    return diffEditor
  }

  function syncBulkActions(queueLength: number): void {
    bulkActions.hidden = queueLength <= 1
  }

  function renderProposedSection(queue: { path: string }[]): void {
    if (queue.length === 0) return
    const section = el('div', { class: 'git-changes-section git-changes-section-proposed' })
    section.append(el('div', { class: 'git-changes-section-title' }, `Proposed (${queue.length})`))
    for (const entry of queue) {
      const isSelected = selection?.kind === 'proposed' && selection.path === entry.path
      const row = el(
        'button',
        {
          type: 'button',
          class: `git-change-row git-change-row-proposed${isSelected ? ' is-selected' : ''}`,
        },
        el('span', { class: 'git-change-status git-change-status-proposed' }, 'P'),
        el('span', { class: 'git-change-path' }, entry.path),
      )
      row.addEventListener('click', () => void selectProposed(entry.path))
      section.append(row)
    }
    listBody.append(section)
  }

  function renderGitSection(title: string, changes: GitChange[], staged: boolean) {
    if (changes.length === 0) return
    const section = el('div', { class: 'git-changes-section' })
    section.append(
      el('div', { class: 'git-changes-section-title' }, `${title} (${changes.length})`),
    )
    for (const change of changes) {
      const isSelected =
        selection?.kind === 'git' && selection.path === change.path && selection.staged === staged
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
      row.addEventListener('click', () => void selectGitChange(change.path, staged))
      section.append(row)
    }
    listBody.append(section)
  }

  function renderList() {
    const queue = store.getState().stagedDiffs ?? []
    syncBulkActions(queue.length)
    clear(listBody)

    renderProposedSection(queue)

    if (!gitAvailable) {
      if (queue.length === 0) {
        listBody.append(el('div', { class: 'git-changes-empty' }, 'Not a git repository'))
      }
      return
    }

    const hasGitChanges = status != null && (status.staged.length > 0 || status.unstaged.length > 0)
    if (!hasGitChanges && queue.length === 0) {
      listBody.append(el('div', { class: 'git-changes-empty' }, 'No changes'))
      return
    }

    if (status) {
      renderGitSection('Staged', status.staged, true)
      renderGitSection('Unstaged', status.unstaged, false)
    }
  }

  function hideApprovalButtons(): void {
    acceptBtn.hidden = true
    rejectBtn.hidden = true
  }

  async function showProposedDiff(view: ActiveDiff): Promise<void> {
    const requestId = ++selectRequestId
    pendingSelect = { kind: 'proposed', path: view.path }
    acceptBtn.hidden = false
    rejectBtn.hidden = false
    acceptBtn.onclick = () => void api.diff.approve(view.path)
    rejectBtn.onclick = () => void api.diff.reject(view.path)

    cancelPendingDiffReveal?.()
    cancelPendingDiffReveal = revealFirstDiffChangeOnNextUpdate(ensureDiffEditor())

    await whenDiffHostVisible(viewerRoot)
    if (requestId !== selectRequestId || pendingSelect?.path !== view.path) return

    emptyState.hidden = true
    imageWrap.hidden = true
    diffWrap.hidden = false
    disposeDiffModels(ensureDiffEditor())
    ensureDiffEditor().setModel({
      original: monaco.editor.createModel(view.before, view.language),
      modified: monaco.editor.createModel(view.after, view.language),
    })
    await new Promise<void>((resolve) => {
      const timeout = window.setTimeout(() => {
        disposable.dispose()
        resolve()
      }, 1_000)
      const disposable = ensureDiffEditor().onDidUpdateDiff(() => {
        window.clearTimeout(timeout)
        disposable.dispose()
        resolve()
      })
    })
    if (requestId !== selectRequestId) return
    await refreshGitChangesDiffCollapse(ensureDiffEditor())
    ensureDiffEditor().layout()
    revealFirstDiffChange(ensureDiffEditor())
  }

  async function selectProposed(path: string): Promise<void> {
    const { stagedDiffs, activeDiff } = store.getState()
    const queue = stagedDiffs ?? []
    pruneStagedDiffCache(proposedDiffCache, queue)
    if (activeDiff) proposedDiffCache.set(activeDiff.path, activeDiff)
    selection = { kind: 'proposed', path }
    renderList()
    const view = resolveStagedDiffView(queue, proposedDiffCache, path, activeDiff)
    if (!view) {
      clearViewer()
      return
    }
    await showProposedDiff(view)
  }

  async function selectGitChange(path: string, staged: boolean) {
    const requestId = ++selectRequestId
    selection = { kind: 'git', path, staged }
    pendingSelect = { kind: 'git', path, staged }
    hideApprovalButtons()
    renderList()
    const diff = await api.git.fileDiff(path, staged)
    if (
      requestId !== selectRequestId ||
      pendingSelect?.kind !== 'git' ||
      pendingSelect.path !== path ||
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
          pendingSelect?.kind !== 'git' ||
          pendingSelect.path !== path ||
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

  function clearViewer() {
    selectRequestId++
    pendingSelect = null
    cancelPendingDiffReveal?.()
    cancelPendingDiffReveal = null
    hideApprovalButtons()
    emptyState.hidden = false
    emptyState.textContent = 'Select a changed file'
    diffWrap.hidden = true
    imageWrap.hidden = true
    clear(imageWrap)
    if (diffEditor) disposeDiffModels(diffEditor)
  }

  function clearSelection() {
    selection = null
    clearViewer()
  }

  async function syncSelection() {
    const { stagedDiffs, activeDiff } = store.getState()
    const queue = stagedDiffs ?? []
    let current = selection

    if (current?.kind === 'proposed') {
      const proposedPath = current.path
      if (!queue.some((e) => e.path === proposedPath)) current = null
    }
    if (current?.kind === 'git') {
      const gitSel = current
      const stillExists = gitSel.staged
        ? status?.staged.some((c) => c.path === gitSel.path)
        : status?.unstaged.some((c) => c.path === gitSel.path)
      if (!stillExists) current = null
    }
    selection = current

    if (selection?.kind === 'proposed') {
      await selectProposed(selection.path)
      return
    }
    if (selection?.kind === 'git') {
      await selectGitChange(selection.path, selection.staged)
      return
    }

    const proposedPath = defaultProposedPath(queue, activeDiff)
    if (proposedPath) {
      await selectProposed(proposedPath)
      return
    }

    const firstGit = status ? getFirstGitChange(status) : null
    if (firstGit) {
      await selectGitChange(firstGit.path, firstGit.staged)
    } else {
      clearSelection()
    }
  }

  async function refresh() {
    gitAvailable = await api.git.isAvailable()
    if (!gitAvailable) {
      status = null
      renderList()
      await syncSelection()
      return
    }
    status = await api.git.status()
    renderList()
    await syncSelection()
  }

  async function syncFromStore() {
    renderList()
    await syncSelection()
  }

  function scheduleRefresh() {
    if (!changesModeActive(store)) return
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => void refresh(), 500)
  }

  refreshBtn.addEventListener('click', () => void refresh())

  const stopObservingLayout = observeDiffHostLayout(viewerRoot, () => diffEditor)

  const unsubDiffConflict = api.diff.onConflict((paths) => {
    conflictBanner.hidden = false
    conflictBanner.textContent =
      paths.length === 1
        ? `${paths[0]} changed on disk since this diff was staged. The diff was refreshed against the current file — review and re-approve to keep your changes.`
        : `${paths.length} files changed on disk since they were staged. Their diffs were refreshed against the current files — review and re-approve.`
    if (paths[0]) {
      store.setState({ rightPanelMode: 'changes', filesPaneOpen: true })
      store.emit('right_panel_mode_changed')
      store.emit('files_pane_changed')
      selection = { kind: 'proposed', path: paths[0] }
      void syncFromStore()
    }
  })

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
      conflictBanner.hidden = true
      if (changesModeActive(store)) void refresh()
      else renderList()
    }),
    store.on('theme_changed', (theme) => {
      monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
    }),
    store.on('staged_diffs_changed', () => {
      const queue = store.getState().stagedDiffs ?? []
      if (queue.length === 0) conflictBanner.hidden = true
      if (changesModeActive(store)) void syncFromStore()
      else renderList()
    }),
    store.on('panel_changed', () => {
      if (changesModeActive(store)) void syncFromStore()
    }),
    api.fs.onChanged(() => scheduleRefresh()),
  ]

  renderList()
  clearSelection()

  return () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    stopObservingLayout()
    unsubDiffConflict()
    unsubs.forEach((u) => u())
    cancelPendingDiffReveal?.()
    diffEditor?.dispose()
    diffEditor = null
  }
}
