import type * as Monaco from 'monaco-editor'
import { el, clear } from '../dom/helpers.ts'
import { refreshIcon } from '../dom/icons.ts'
import { panePopoutButton } from './pane-popout-button.ts'
import { at } from '@shared/array-utils.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type {
  GitChange,
  GitChangeStatus,
  GitFileDiff,
  GitStatusResult,
  SessionBackup,
} from '@shared/types/git.ts'
import { showToast, showErrorToast } from './toast.ts'
import type { ActiveDiff } from '@shared/types/state.ts'
import {
  pruneStagedDiffCache,
  resolveStagedDiffView,
  shouldJumpToProposed,
} from '@shared/diff/staged-diff-ui.ts'
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
  const [first] = queue
  if (!first) return null
  if (activeDiff && queue.some((e) => e.path === activeDiff.path)) return activeDiff.path
  return first.path
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
    refreshIcon('ui-icon ui-icon-sm'),
  )
  listHeader.append(
    headerTitle,
    bulkActions,
    panePopoutButton(api, 'changes', 'changes'),
    refreshBtn,
  )

  // "Restore pre-session changes": surfaces the session's refs/copse/backups/*
  // snapshot so a user can one-click revert the paths Copse auto-applied over
  // their uncommitted work back to their pre-session content (#699).
  const restoreBanner = el('div', { class: 'git-changes-restore' })
  const restoreLabel = el('span', { class: 'git-changes-restore-label' })
  const restoreBtn = el(
    'button',
    { type: 'button', class: 'git-changes-restore-btn' },
    'Restore pre-session changes',
  )
  restoreBanner.append(restoreLabel, restoreBtn)
  restoreBanner.hidden = true

  const listBody = el('div', { class: 'git-changes-list' })
  listRoot.append(listHeader, restoreBanner, listBody)

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
  let sessionBackup: SessionBackup | null = null
  let restoreInFlight = false
  let selection: ChangeSelection | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let cancelPendingDiffReveal: (() => void) | null = null
  const proposedDiffCache = new Map<string, ActiveDiff>()
  let pendingNavigate: string | null = null
  // Path of a freshly proposed diff the pane should jump to on the next sync,
  // even if an earlier (still-valid) selection would otherwise be preserved.
  let pendingProposedNavigate: string | null = null

  acceptAllBtn.addEventListener('click', () => void api.diff.approveAll())
  rejectAllBtn.addEventListener('click', () => void api.diff.rejectAll())

  api.diff.onShowDiff((path, before, after, language) => {
    proposedDiffCache.set(path, { path, before, after, language })
    // A just-proposed change is the file the agent is now waiting on; jump to it
    // even when a stale-but-valid selection would otherwise stick (#484).
    pendingProposedNavigate = path
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
    section.append(
      el('div', { class: 'git-changes-section-title' }, `Proposed (${String(queue.length)})`),
    )
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

  function renderGitSection(title: string, changes: GitChange[], staged: boolean): void {
    if (changes.length === 0) return
    const section = el('div', { class: 'git-changes-section' })
    section.append(
      el('div', { class: 'git-changes-section-title' }, `${title} (${String(changes.length)})`),
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

  function renderList(): void {
    const queue = store.getState().stagedDiffs
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

  function renderRestoreBanner(): void {
    const paths = sessionBackup?.paths ?? []
    if (paths.length === 0) {
      restoreBanner.hidden = true
      return
    }
    restoreBanner.hidden = false
    restoreLabel.textContent =
      paths.length === 1
        ? '1 file was changed over your uncommitted work this session.'
        : `${String(paths.length)} files were changed over your uncommitted work this session.`
    restoreBtn.disabled = restoreInFlight
  }

  async function restorePreSessionChanges(): Promise<void> {
    const backup = sessionBackup
    if (!backup || restoreInFlight) return
    const count = backup.paths.length
    const confirmed = window.confirm(
      `Restore ${count === 1 ? 'this file' : `these ${String(count)} files`} to their state ` +
        `before this session? Any edits Copse applied to ` +
        `${count === 1 ? 'it' : 'them'} will be replaced with your pre-session version. ` +
        `A snapshot of the current state is kept so this can be undone via git.`,
    )
    if (!confirmed) return
    restoreInFlight = true
    renderRestoreBanner()
    try {
      const ok = await api.git.restoreBackup()
      if (ok) {
        showToast(
          count === 1
            ? 'Restored 1 pre-session file.'
            : `Restored ${String(count)} pre-session files.`,
        )
      } else {
        showToast('Could not restore pre-session changes.', { variant: 'error' })
      }
    } catch (error) {
      showErrorToast('Restore failed', error)
    } finally {
      restoreInFlight = false
      await refresh()
    }
  }

  restoreBtn.addEventListener('click', () => void restorePreSessionChanges())

  function hideApprovalButtons(): void {
    acceptBtn.hidden = true
    rejectBtn.hidden = true
  }

  async function showProposedDiff(view: ActiveDiff): Promise<void> {
    const requestId = ++selectRequestId
    pendingSelect = { kind: 'proposed', path: view.path }
    acceptBtn.hidden = false
    rejectBtn.hidden = false
    acceptBtn.onclick = (): void => void api.diff.approve(view.path)
    rejectBtn.onclick = (): void => void api.diff.reject(view.path)

    cancelPendingDiffReveal?.()
    cancelPendingDiffReveal = revealFirstDiffChangeOnNextUpdate(ensureDiffEditor())

    await whenDiffHostVisible(viewerRoot)
    if (requestId !== selectRequestId || pendingSelect.path !== view.path) return

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
    const queue = stagedDiffs
    pruneStagedDiffCache(proposedDiffCache, queue)
    if (activeDiff) proposedDiffCache.set(activeDiff.path, activeDiff)
    selection = { kind: 'proposed', path }
    renderList()
    let view = resolveStagedDiffView(queue, proposedDiffCache, path, activeDiff)
    if (!view && queue.some((e) => e.path === path)) {
      // The queue lists this file but its full content never reached the cache —
      // the `agent:show_diff` push predates this (async/re-)mount and nothing
      // replays it. Pull the content the main-process queue still holds so the
      // diff renders instead of clearing to an empty pane.
      const requestId = ++selectRequestId
      const fetched = await api.diff.content(path)
      if (requestId !== selectRequestId) return
      if (fetched) {
        proposedDiffCache.set(path, fetched)
        view = fetched
      }
    }
    if (!view) {
      clearViewer()
      return
    }
    await showProposedDiff(view)
  }

  async function selectGitChange(path: string, staged: boolean): Promise<void> {
    const requestId = ++selectRequestId
    selection = { kind: 'git', path, staged }
    pendingSelect = { kind: 'git', path, staged }
    hideApprovalButtons()
    renderList()
    const diff = await api.git.fileDiff(path, staged)
    if (
      requestId !== selectRequestId ||
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

  function clearViewer(): void {
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

  function clearSelection(): void {
    selection = null
    clearViewer()
  }

  async function syncSelection(): Promise<void> {
    const { stagedDiffs, activeDiff } = store.getState()
    const queue = stagedDiffs

    // A freshly proposed diff takes priority over any existing selection so the
    // pane jumps to the file the agent just proposed and is waiting on (#484).
    // `agent:show_diff` arrives before the `diff:queued` broadcast that adds the
    // path to the queue, so the target is consumed only once it is queued —
    // until then it is kept pending for the follow-up sync.
    if (shouldJumpToProposed(pendingProposedNavigate, queue)) {
      const proposedNavTarget = pendingProposedNavigate
      pendingProposedNavigate = null
      selection = { kind: 'proposed', path: proposedNavTarget }
      await selectProposed(proposedNavTarget)
      return
    }

    // A git_change_navigate request takes priority over the existing selection.
    const navTarget = pendingNavigate
    pendingNavigate = null
    if (navTarget && status) {
      const inUnstaged = status.unstaged.some((c) => c.path === navTarget)
      const inStaged = status.staged.some((c) => c.path === navTarget)
      if (inUnstaged || inStaged) {
        const staged = !inUnstaged && inStaged
        selection = { kind: 'git', path: navTarget, staged }
        await selectGitChange(navTarget, staged)
        return
      }
    }

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

  async function refresh(): Promise<void> {
    gitAvailable = await api.git.isAvailable()
    if (!gitAvailable) {
      status = null
      sessionBackup = null
      renderRestoreBanner()
      renderList()
      await syncSelection()
      return
    }
    status = await api.git.status()
    sessionBackup = await api.git.sessionBackup()
    renderRestoreBanner()
    renderList()
    await syncSelection()
  }

  async function syncFromStore(): Promise<void> {
    renderList()
    await syncSelection()
  }

  function scheduleRefresh(): void {
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
        ? `${at(paths, 0)} changed on disk since this diff was staged. The diff was refreshed against the current file — review and re-approve to keep your changes.`
        : `${String(paths.length)} files changed on disk since they were staged. Their diffs were refreshed against the current files — review and re-approve.`
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
    store.on('git_change_navigate', (path) => {
      pendingNavigate = path
      if (changesModeActive(store)) void refresh()
    }),
    store.on('files_pane_changed', () => {
      if (changesModeActive(store)) void refresh()
    }),
    store.on('workspace_changed', () => {
      status = null
      sessionBackup = null
      renderRestoreBanner()
      pendingProposedNavigate = null
      clearSelection()
      conflictBanner.hidden = true
      if (changesModeActive(store)) void refresh()
      else renderList()
    }),
    store.on('theme_changed', (theme) => {
      monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
    }),
    store.on('staged_diffs_changed', () => {
      const queue = store.getState().stagedDiffs
      if (queue.length === 0) conflictBanner.hidden = true
      if (changesModeActive(store)) void syncFromStore()
      else renderList()
    }),
    store.on('panel_changed', () => {
      if (changesModeActive(store)) void syncFromStore()
    }),
    api.fs.onChanged(() => {
      scheduleRefresh()
    }),
  ]

  renderList()
  clearSelection()

  // This pane is mounted asynchronously, once the Monaco bundle resolves. If the
  // right panel is already in "changes" mode by the time we mount (the common
  // case, since the mode is restored before Monaco loads), no
  // right_panel_mode_changed event will arrive to trigger the first refresh — so
  // catch up to the current state here, or the diff never renders. See #459.
  if (changesModeActive(store)) void refresh()

  return () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    stopObservingLayout()
    unsubDiffConflict()
    unsubs.forEach((u) => {
      u()
    })
    cancelPendingDiffReveal?.()
    diffEditor?.dispose()
    diffEditor = null
  }
}
