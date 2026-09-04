import { el, clear } from '../dom/helpers.ts'
import { refreshIcon } from '../dom/icons.ts'
import { setInlineStatus } from '../dom/inline-status.ts'
import { paneLoadingRow } from '../dom/pane-loading.ts'
import { paneMaximizeButton } from './pane-maximize-button.ts'
import { panePopoutButton } from './pane-popout-button.ts'
import { registerPopoutSeedHandlers } from '../popout/pane-popout-seed.ts'
import { at } from '@shared/array-utils.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type {
  GitChange,
  GitChangeStatus,
  GitCommittedChanges,
  GitFileDiff,
  GitStatusResult,
  SessionBackup,
} from '@shared/types/git.ts'
import { showToast, showErrorToast } from './toast.ts'
import { showConfirmDialog } from './confirm-dialog.ts'
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
  type GitDiffEditor,
  type GitDiffMonaco,
} from '../monaco/git-diff-viewer.ts'
import { registerMonacoSelectionToChatShortcut } from '../monaco/selection-to-chat.ts'
import { scaledEditorFontSize } from '@shared/ui-scale.ts'
import { isImageDiff, renderImageDiff } from './git-image-diff.ts'
import { materialFolderIconUrl } from '../icons/material-file-icons.ts'

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
  | { kind: 'committed'; path: string }

/** Validates a pop-out seed before it drives selection. The previous assertion
 * trusted the shape outright, so a malformed seed reached selectGitChange with
 * `staged` undefined. */
function isChangeSelection(seed: unknown): seed is ChangeSelection {
  if (!seed || typeof seed !== 'object') return false
  if (!('kind' in seed) || !('path' in seed) || typeof seed.path !== 'string') return false
  if (seed.kind === 'proposed' || seed.kind === 'committed') return true
  return seed.kind === 'git' && 'staged' in seed && typeof seed.staged === 'boolean'
}

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
  monaco: GitDiffMonaco | null,
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
      'data-tooltip': 'Refresh changes',
    },
    refreshIcon('ui-icon ui-icon-sm'),
  )
  listHeader.append(
    headerTitle,
    bulkActions,
    panePopoutButton(store, api, 'changes', 'changes'),
    paneMaximizeButton(store, 'changes'),
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
  const diffWrap = el('div', { class: 'git-diff-editor-wrap' })
  const acceptBtn = el('button', { type: 'button', class: 'diff-accept-btn' }, 'Accept')
  const rejectBtn = el('button', { type: 'button', class: 'diff-reject-btn' }, 'Reject')
  acceptBtn.hidden = true
  rejectBtn.hidden = true
  // A bar below the editor, not an overlay: floating buttons sat on top of the
  // last visible lines (and the editor's right-edge chrome) in narrow panes (#1702).
  const approvalBar = el('div', { class: 'diff-approval-bar' })
  approvalBar.hidden = true
  approvalBar.append(rejectBtn, acceptBtn)
  const imageWrap = el('div', { class: 'git-image-diff-wrap' })
  // File listing shown when the selected change is an untracked directory
  // (`git status` collapses those to one record, so there is no diff to show).
  const dirWrap = el('div', { class: 'git-dir-view' })
  dirWrap.hidden = true
  const emptyState = el('div', { class: 'panel-empty' }, 'Select a changed file')
  viewerRoot.append(conflictBanner, diffWrap, approvalBar, imageWrap, dirWrap, emptyState)

  let diffEditor: GitDiffEditor | null = null
  let pendingSelect: ChangeSelection | null = null
  let selectRequestId = 0
  let diffLoadQueue: Promise<void> = Promise.resolve()
  let status: GitStatusResult | null = null
  let committed: GitCommittedChanges | null = null
  let gitAvailable = false
  // False until the first refresh for the current owner has settled (and reset
  // whenever a workspace/thread switch invalidates what we know). The empty
  // states below — "Not a git repository", "No changes" — are answers about the
  // repo, and rendering them before the probe returns states them about a repo
  // we have not looked at yet. They look identical to the real thing, so that
  // guess is what the user believes; on a cold start it is also the first thing
  // they see, because this pane mounts behind the Monaco bundle.
  let loaded = false
  let sessionBackup: SessionBackup | null = null
  let restoreInFlight = false
  let selection: ChangeSelection | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let refreshRequestId = 0
  let gitFailureLogged = false
  const proposedDiffCachesByOwner = new Map<string, Map<string, ActiveDiff>>()
  let pendingNavigate: string | null = null
  // Path of a freshly proposed diff the pane should jump to on the next sync,
  // even if an earlier (still-valid) selection would otherwise be preserved.
  let pendingProposedNavigate: string | null = null

  /**
   * A failed git IPC read leaves the pane with nothing trustworthy to render,
   * but the failure itself is not user-actionable: it is usually a thread whose
   * worktree is mid-validation or not persisted yet (#1880). Log once per burst
   * and render the same empty state instead of stacking inspector warnings.
   */
  function markGitUnavailable(scope: string, error: unknown): void {
    if (gitFailureLogged) return
    gitFailureLogged = true
    console.warn(`[git-changes-pane] ${scope} failed:`, error)
  }
  // A pop-out is seeded with the parent window's selection before its own diff
  // queue has hydrated, so an early `refresh()` would see an empty queue, judge
  // the selection dead, and fall through to an unrelated git file (#1704). Hold
  // the seeded path across that window. One-shot: dropped as soon as this pane
  // has a queue to judge against, whether or not the path survived in it.
  let seededProposedPath: string | null = null

  function activeOwner(): { projectId: string; threadId: string } | null {
    const { activeProjectId, activeThreadId } = store.getState()
    return activeProjectId && activeThreadId
      ? { projectId: activeProjectId, threadId: activeThreadId }
      : null
  }

  function proposedDiffCacheFor(projectId: string, threadId: string): Map<string, ActiveDiff> {
    const key = JSON.stringify([projectId, threadId])
    let cache = proposedDiffCachesByOwner.get(key)
    if (!cache) {
      cache = new Map()
      proposedDiffCachesByOwner.set(key, cache)
    }
    return cache
  }

  acceptAllBtn.addEventListener('click', () => {
    const owner = activeOwner()
    if (owner) void api.diff.approveAll(owner.projectId, owner.threadId)
  })
  rejectAllBtn.addEventListener('click', () => {
    const owner = activeOwner()
    if (owner) void api.diff.rejectAll(owner.projectId, owner.threadId)
  })

  api.diff.onShowDiff((projectId, threadId, path, before, after, language) => {
    proposedDiffCacheFor(projectId, threadId).set(path, { path, before, after, language })
    const owner = activeOwner()
    if (!owner || owner.projectId !== projectId || owner.threadId !== threadId) return
    // A just-proposed change is the file the agent is now waiting on; jump to it
    // even when a stale-but-valid selection would otherwise stick (#484).
    pendingProposedNavigate = path
    if (changesModeActive(store)) void syncFromStore()
  })

  function ensureDiffEditor(): GitDiffEditor {
    const monacoApi = requireMonaco()
    if (!diffEditor) {
      const theme = store.getState().theme === 'dark' ? 'vs-dark' : 'vs'
      diffEditor = createGitChangesDiffEditor(
        diffWrap,
        monacoApi,
        scaledEditorFontSize(store.getState().fontSize, store.getState().uiScale),
        theme,
      )
      registerMonacoSelectionToChatShortcut(diffEditor.getOriginalEditor(), monacoApi, () => {
        if (selection?.kind === 'proposed') {
          return { path: selection.path, detail: 'before' }
        }
        if (selection?.kind === 'git') {
          return { path: selection.path, detail: 'before' }
        }
        return null
      })
      registerMonacoSelectionToChatShortcut(diffEditor.getModifiedEditor(), monacoApi, () => {
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

  function requireMonaco(): GitDiffMonaco {
    if (monaco === null) throw new Error('Monaco is unavailable while rendering a diff')
    return monaco
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
          'data-tooltip': entry.path,
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
          'data-tooltip': change.isDirectory ? `${change.path} — Untracked directory` : change.path,
        },
        el(
          'span',
          { class: `git-change-status git-change-status-${change.status}` },
          STATUS_LABEL[change.status],
        ),
      )
      if (change.isDirectory) {
        row.append(
          el('img', {
            class: 'git-change-dir-icon',
            src: materialFolderIconUrl(change.path, false),
            alt: '',
            width: '16',
            height: '16',
            decoding: 'async',
          }),
        )
      }
      row.append(el('span', { class: 'git-change-path' }, change.path))
      row.addEventListener('click', () => void selectGitChange(change.path, staged))
      section.append(row)
    }
    listBody.append(section)
  }

  /**
   * Commits that no pull request carries yet. Without this section the pane goes
   * blank the moment an agent commits — the work has left `git status` and has
   * nowhere else to show until a PR exists.
   */
  function renderCommittedSection(view: GitCommittedChanges): void {
    if (view.changes.length === 0) return
    const section = el('div', { class: 'git-changes-section git-changes-section-committed' })
    section.append(
      el(
        'div',
        {
          class: 'git-changes-section-title',
          'data-tooltip': `Committed here but not in a pull request yet (compared against ${view.baseLabel})`,
        },
        `Committed (${String(view.changes.length)})`,
      ),
    )
    for (const change of view.changes) {
      const isSelected = selection?.kind === 'committed' && selection.path === change.path
      const row = el(
        'button',
        {
          type: 'button',
          class: `git-change-row git-change-row-committed${isSelected ? ' is-selected' : ''}`,
          'data-tooltip': change.path,
        },
        el(
          'span',
          { class: `git-change-status git-change-status-${change.status}` },
          STATUS_LABEL[change.status],
        ),
        el('span', { class: 'git-change-path' }, change.path),
      )
      row.addEventListener('click', () => void selectCommittedChange(change.path))
      section.append(row)
    }
    listBody.append(section)
  }

  function renderList(): void {
    const queue = store.getState().stagedDiffs
    syncBulkActions(queue.length)
    clear(listBody)

    renderProposedSection(queue)

    if (!loaded) {
      // Proposed diffs come from the store and are already accurate; only the
      // git-derived part of the list is unknown this early.
      if (queue.length === 0) listBody.append(paneLoadingRow('Loading changes…'))
      return
    }

    if (!gitAvailable) {
      if (queue.length === 0) {
        listBody.append(el('div', { class: 'git-changes-empty' }, 'Not a git repository'))
      }
      return
    }

    const hasGitChanges = status != null && (status.staged.length > 0 || status.unstaged.length > 0)
    const hasCommitted = (committed?.changes.length ?? 0) > 0
    if (!hasGitChanges && !hasCommitted && queue.length === 0) {
      listBody.append(el('div', { class: 'git-changes-empty' }, 'No changes'))
      return
    }

    if (status) {
      renderGitSection('Staged', status.staged, true)
      renderGitSection('Unstaged', status.unstaged, false)
    }
    // Last: committed work is settled relative to the working tree above it, and
    // keeping it below preserves which row the pane auto-selects.
    if (committed) renderCommittedSection(committed)
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
    const confirmed = await showConfirmDialog({
      message:
        `Restore ${count === 1 ? 'this file' : `these ${String(count)} files`} to their state ` +
        `before this session?`,
      detail:
        `Any edits Copse applied to ${count === 1 ? 'it' : 'them'} will be replaced with your pre-session version. ` +
        `A snapshot of the current state is kept so this can be undone via git.`,
      confirmLabel: 'Restore',
      danger: true,
    })
    if (!confirmed) return
    restoreInFlight = true
    renderRestoreBanner()
    try {
      const owner = activeOwner()
      if (!owner) return
      const ok = await api.git.restoreBackup(owner.projectId, owner.threadId)
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
    approvalBar.hidden = true
    acceptBtn.hidden = true
    rejectBtn.hidden = true
  }

  async function showProposedDiff(view: ActiveDiff): Promise<void> {
    const requestId = ++selectRequestId
    pendingSelect = { kind: 'proposed', path: view.path }
    approvalBar.hidden = false
    acceptBtn.hidden = false
    rejectBtn.hidden = false
    acceptBtn.onclick = (): void => {
      const owner = activeOwner()
      if (owner) void api.diff.approve(owner.projectId, owner.threadId, view.path)
    }
    rejectBtn.onclick = (): void => {
      const owner = activeOwner()
      if (owner) void api.diff.reject(owner.projectId, owner.threadId, view.path)
    }

    // Unhide the wrap *before* creating/laying out Monaco — creating the editor
    // while `diffWrap` is still `hidden` (zero size) races layout and leaves the
    // first change off-screen after lazy Monaco load.
    emptyState.hidden = true
    imageWrap.hidden = true
    dirWrap.hidden = true
    diffWrap.hidden = false

    const proposed: GitFileDiff = {
      path: view.path,
      before: view.before,
      after: view.after,
      language: view.language,
    }
    // Store and IPC events can request the same/new proposed diff several times
    // while Monaco is still computing the previous view-model. Keep all diff
    // work on one queue and let only the latest request attach its model.
    diffLoadQueue = diffLoadQueue
      .catch(() => undefined)
      .then(async () => {
        const isCurrent = (): boolean =>
          requestId === selectRequestId &&
          pendingSelect?.kind === 'proposed' &&
          pendingSelect.path === view.path
        if (!isCurrent()) return
        // Defer Monaco construction until the host has a real size — creating
        // the editor while Changes is still closed (0×0) leaves a blank viewer
        // after the panel opens, and a hung visibility wait used to stall this
        // shared queue so later file clicks never attached a model.
        await setGitFileDiffModel(
          () => ensureDiffEditor(),
          requireMonaco(),
          proposed,
          viewerRoot,
          isCurrent,
        )
      })
    await diffLoadQueue
  }

  async function selectProposed(path: string): Promise<void> {
    const { stagedDiffs, activeDiff } = store.getState()
    const owner = activeOwner()
    if (!owner) {
      clearViewer()
      return
    }
    const proposedDiffCache = proposedDiffCacheFor(owner.projectId, owner.threadId)
    const queue = stagedDiffs
    // An empty queue inside the pop-out's hydration window means "not known
    // yet", not "nothing proposed". Pruning against it would discard the content
    // just fetched for the seeded path and re-fetch it on every sync (#1704).
    if (queue.length > 0 || seededProposedPath === null) {
      pruneStagedDiffCache(proposedDiffCache, queue)
    }
    if (activeDiff) proposedDiffCache.set(activeDiff.path, activeDiff)
    selection = { kind: 'proposed', path }
    renderList()
    let view = resolveStagedDiffView(queue, proposedDiffCache, path, activeDiff)
    if (!view) {
      // The full content never reached the cache — the `agent:show_diff` push
      // predates this (async/re-)mount and nothing replays it. Pull the content
      // the main-process queue still holds so the diff renders instead of
      // clearing to an empty pane.
      //
      // Deliberately not gated on the path being in `queue`: a pop-out seeded
      // with a proposed selection can arrive before its own queue has hydrated,
      // and gating here made it silently fall through to an unrelated git file
      // (#1704). The main process answers `null` for anything it is not holding,
      // which is the same outcome the gate produced.
      const requestId = ++selectRequestId
      const fetched = await api.diff.content(owner.projectId, owner.threadId, path)
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
    const owner = activeOwner()
    if (!owner) return
    let diff: GitFileDiff | null = null
    try {
      diff = await api.git.fileDiff(owner.projectId, owner.threadId, path, staged)
    } catch (error) {
      markGitUnavailable(`diff read for ${path}`, error)
    }
    if (
      requestId !== selectRequestId ||
      activeOwner()?.projectId !== owner.projectId ||
      activeOwner()?.threadId !== owner.threadId ||
      pendingSelect.path !== path ||
      pendingSelect.staged !== staged
    ) {
      return
    }
    if (!diff) {
      emptyState.hidden = false
      diffWrap.hidden = true
      imageWrap.hidden = true
      dirWrap.hidden = true
      emptyState.textContent = 'Could not load diff'
      return
    }
    if (diff.directoryFiles) {
      renderDirectoryView(diff)
      emptyState.hidden = true
      diffWrap.hidden = true
      imageWrap.hidden = true
      dirWrap.hidden = false
      if (diffEditor) disposeDiffModels(diffEditor)
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
        dirWrap.hidden = true
        if (isImageDiff(diff)) {
          diffWrap.hidden = true
          imageWrap.hidden = false
          if (diffEditor) disposeDiffModels(diffEditor)
          renderImageDiff(imageWrap, diff)
          return
        }
        imageWrap.hidden = true
        diffWrap.hidden = false
        await setGitFileDiffModel(
          () => ensureDiffEditor(),
          requireMonaco(),
          diff,
          viewerRoot,
          () =>
            requestId === selectRequestId &&
            pendingSelect?.kind === 'git' &&
            pendingSelect.path === path &&
            pendingSelect.staged === staged,
        )
      })
    await diffLoadQueue
  }

  async function selectCommittedChange(path: string): Promise<void> {
    const requestId = ++selectRequestId
    selection = { kind: 'committed', path }
    pendingSelect = { kind: 'committed', path }
    hideApprovalButtons()
    renderList()
    const owner = activeOwner()
    if (!owner) return
    let diff: GitFileDiff | null = null
    try {
      diff = await api.git.committedFileDiff(owner.projectId, owner.threadId, path)
    } catch (error) {
      markGitUnavailable(`committed diff read for ${path}`, error)
    }
    if (
      requestId !== selectRequestId ||
      activeOwner()?.projectId !== owner.projectId ||
      activeOwner()?.threadId !== owner.threadId ||
      pendingSelect.path !== path
    ) {
      return
    }
    if (!diff) {
      emptyState.hidden = false
      diffWrap.hidden = true
      imageWrap.hidden = true
      dirWrap.hidden = true
      emptyState.textContent = 'Could not load diff'
      return
    }
    diffLoadQueue = diffLoadQueue
      .catch(() => undefined)
      .then(async () => {
        const isCurrent = (): boolean =>
          requestId === selectRequestId &&
          pendingSelect?.kind === 'committed' &&
          pendingSelect.path === path
        if (!isCurrent()) return
        emptyState.hidden = true
        dirWrap.hidden = true
        if (isImageDiff(diff)) {
          diffWrap.hidden = true
          imageWrap.hidden = false
          if (diffEditor) disposeDiffModels(diffEditor)
          renderImageDiff(imageWrap, diff)
          return
        }
        imageWrap.hidden = true
        diffWrap.hidden = false
        await setGitFileDiffModel(
          () => ensureDiffEditor(),
          requireMonaco(),
          diff,
          viewerRoot,
          isCurrent,
        )
      })
    await diffLoadQueue
  }

  /**
   * Viewer for an untracked directory: `git status` collapses a wholly-new
   * directory into one record, so there is no per-file diff to show. List the
   * contained files instead of a blank editor; each opens its own new-file diff.
   */
  function renderDirectoryView(diff: GitFileDiff): void {
    clear(dirWrap)
    const files = diff.directoryFiles ?? []
    const total = diff.directoryFileCount ?? files.length
    dirWrap.append(
      el(
        'div',
        { class: 'git-dir-view-header' },
        el('img', {
          class: 'git-change-dir-icon',
          src: materialFolderIconUrl(diff.path, true),
          alt: '',
          width: '16',
          height: '16',
          decoding: 'async',
        }),
        el('span', { class: 'git-dir-view-title' }, diff.path),
        el(
          'span',
          { class: 'git-dir-view-count' },
          `Untracked directory · ${String(total)} ${total === 1 ? 'file' : 'files'}`,
        ),
      ),
    )
    if (total > files.length) {
      dirWrap.append(
        el('div', { class: 'git-dir-view-note' }, `Showing the first ${String(files.length)}.`),
      )
    }
    const list = el('div', { class: 'git-dir-view-list' })
    for (const file of files) {
      const row = el(
        'button',
        { type: 'button', class: 'git-change-row' },
        el('span', { class: 'git-change-status git-change-status-untracked' }, '?'),
        el('span', { class: 'git-change-path' }, file),
      )
      row.addEventListener('click', () => void selectGitChange(file, false))
      list.append(row)
    }
    dirWrap.append(list)
  }

  function clearViewer(): void {
    selectRequestId++
    pendingSelect = null
    hideApprovalButtons()
    emptyState.hidden = false
    if (loaded) emptyState.textContent = 'Select a changed file'
    else setInlineStatus(emptyState, 'pending', 'Loading changes…')
    diffWrap.hidden = true
    imageWrap.hidden = true
    dirWrap.hidden = true
    clear(imageWrap)
    clear(dirWrap)
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
    if (navTarget) {
      const inUnstaged = status?.unstaged.some((c) => c.path === navTarget) ?? false
      const inStaged = status?.staged.some((c) => c.path === navTarget) ?? false
      if (inUnstaged || inStaged) {
        const staged = !inUnstaged && inStaged
        selection = { kind: 'git', path: navTarget, staged }
        await selectGitChange(navTarget, staged)
        return
      }
      // A file the agent touched and then committed is no longer in `git status`;
      // navigation to it must still land on its diff rather than falling through.
      if (committed?.changes.some((c) => c.path === navTarget)) {
        selection = { kind: 'committed', path: navTarget }
        await selectCommittedChange(navTarget)
        return
      }
    }

    let current = selection

    // Once this pane has a queue it can judge selections against it, so the
    // seed's grace period is over.
    if (queue.length > 0) seededProposedPath = null

    if (current?.kind === 'proposed') {
      const proposedPath = current.path
      const awaitingHydration = proposedPath === seededProposedPath
      if (!awaitingHydration && !queue.some((e) => e.path === proposedPath)) current = null
    }
    if (current?.kind === 'git') {
      const gitSel = current
      // A file opened from the untracked-directory view is not its own status
      // record (git collapsed the directory), so it survives via its parent.
      const stillExists = gitSel.staged
        ? status?.staged.some((c) => c.path === gitSel.path)
        : status?.unstaged.some(
            (c) =>
              c.path === gitSel.path ||
              (c.isDirectory === true && gitSel.path.startsWith(`${c.path}/`)),
          )
      if (!stillExists) current = null
    }
    if (current?.kind === 'committed') {
      const committedSel = current
      if (!committed?.changes.some((c) => c.path === committedSel.path)) current = null
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
    if (selection?.kind === 'committed') {
      await selectCommittedChange(selection.path)
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
      return
    }
    // Nothing uncommitted: a thread whose agent committed everything still has
    // work to review, so open its first committed file rather than an empty pane.
    const firstCommitted = committed?.changes[0]
    if (firstCommitted) {
      await selectCommittedChange(firstCommitted.path)
    } else {
      clearSelection()
    }
  }

  async function refresh(): Promise<void> {
    const requestId = ++refreshRequestId
    const owner = activeOwner()
    if (!owner) {
      // No thread yet — the usual cause is the launch window before threads
      // hydrate, so this is "not known yet", not "no repo". Stay in the loading
      // state; the `threads_changed` that selects a thread refreshes again.
      gitAvailable = false
      loaded = false
      renderList()
      return
    }
    let available = false
    let availabilityFailed = false
    try {
      available = await api.git.isAvailable(owner.projectId, owner.threadId)
    } catch (error) {
      availabilityFailed = true
      markGitUnavailable('git availability check', error)
    }
    const currentOwner = activeOwner()
    if (
      requestId !== refreshRequestId ||
      currentOwner?.projectId !== owner.projectId ||
      currentOwner.threadId !== owner.threadId
    )
      return
    gitAvailable = available
    if (!gitAvailable) {
      if (!availabilityFailed) gitFailureLogged = false
      loaded = true
      status = null
      committed = null
      sessionBackup = null
      renderRestoreBanner()
      renderList()
      await syncSelection()
      return
    }
    let nextStatus
    let nextCommitted
    let nextBackup
    try {
      nextStatus = await api.git.status(owner.projectId, owner.threadId)
      if (requestId !== refreshRequestId) return
      nextCommitted = await api.git.committedChanges(owner.projectId, owner.threadId)
      if (requestId !== refreshRequestId) return
      nextBackup = await api.git.sessionBackup(owner.projectId, owner.threadId)
      if (requestId !== refreshRequestId) return
    } catch (error) {
      markGitUnavailable('git status read', error)
      if (requestId !== refreshRequestId) return
      status = null
      committed = null
      sessionBackup = null
      gitAvailable = false
      loaded = true
      renderRestoreBanner()
      renderList()
      clearViewer()
      return
    }
    gitFailureLogged = false
    // Only now: `gitAvailable` alone still leaves `status`/`committed` null for
    // three more awaits, and any event that repaints the list in that window
    // (an approve, a pop-out sync) would render "No changes" over a repo that
    // has them.
    loaded = true
    status = nextStatus
    committed = nextCommitted
    sessionBackup = nextBackup
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

  const unsubDiffConflict = api.diff.onConflict((projectId, threadId, paths) => {
    const owner = activeOwner()
    if (!owner || owner.projectId !== projectId || owner.threadId !== threadId) return
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
      // The new workspace's git state is unknown until the refresh below lands;
      // holding `loaded` true would show the previous repo's answer as this one's.
      loaded = false
      status = null
      committed = null
      sessionBackup = null
      renderRestoreBanner()
      pendingProposedNavigate = null
      seededProposedPath = null
      clearSelection()
      conflictBanner.hidden = true
      if (changesModeActive(store)) void refresh()
      else renderList()
    }),
    store.on('threads_changed', () => {
      refreshRequestId++
      selectRequestId++
      loaded = false
      status = null
      committed = null
      sessionBackup = null
      selection = null
      seededProposedPath = null
      if (changesModeActive(store)) void refresh()
      else renderList()
    }),
    store.on('theme_changed', (theme) => {
      monaco?.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
    }),
    store.on('staged_diffs_changed', () => {
      const queue = store.getState().stagedDiffs
      if (queue.length === 0) conflictBanner.hidden = true
      if (changesModeActive(store)) void syncFromStore()
      else renderList()
      // Approving or rejecting a diff writes (or restores) the file, so the git
      // sections below are now stale. The main window usually catches this via
      // the `fs:changed` watcher on the open file; nothing did in a second
      // window, which is half of "the changes don't align between the 2
      // windows" (#1704). Debounced, so a multi-file approve-all coalesces.
      scheduleRefresh()
    }),
    store.on('panel_changed', () => {
      if (changesModeActive(store)) void syncFromStore()
    }),
    api.fs.onChanged(() => {
      scheduleRefresh()
    }),
    // Unlike fs.onChanged (an explicitly opened-file watch), this signal comes
    // from the recursive working-tree watcher and therefore catches shell,
    // hook, and external-editor writes anywhere in the checkout (#1753).
    api.git.onWorkingTreeChanged(() => {
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

  const unregisterPopoutSeed = registerPopoutSeedHandlers('changes', {
    capture: () => selection,
    apply: (seed) => {
      if (!isChangeSelection(seed)) return
      if (seed.kind === 'proposed') {
        seededProposedPath = seed.path
        void selectProposed(seed.path)
      } else if (seed.kind === 'committed') void selectCommittedChange(seed.path)
      else void selectGitChange(seed.path, seed.staged)
    },
  })

  return () => {
    unregisterPopoutSeed()
    if (refreshTimer) clearTimeout(refreshTimer)
    stopObservingLayout()
    unsubDiffConflict()
    unsubs.forEach((u) => {
      u()
    })
    diffEditor?.dispose()
    diffEditor = null
  }
}
