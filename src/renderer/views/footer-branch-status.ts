import { el, clear, on } from '../dom/helpers.ts'
import { chevronDownIcon } from '../dom/icons.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type {
  GitBranchInfo,
  GitBranchStatus,
  GitOpenPr,
  ThreadWorktreeAttachment,
} from '@shared/types/git.ts'
import type { Thread } from '@shared/types'
import {
  threadGitBranchMismatch,
  threadGitBranchMismatchMessage,
} from '@shared/git/thread-branch.ts'
import { showErrorToast, showToast } from './toast.ts'
import { getThreadById, isBlankThread } from '@shared/store/thread-helpers.ts'
import { openBrowserUrl } from '../controller/panels.ts'
import { getActiveThreadOwner, type ActiveThreadOwner } from '../controller/active-thread-owner.ts'

const COPIED_BRANCH_TOAST = 'Copied branch name'
const COPY_FEEDBACK_MS = 1600
let nextPickerId = 0

type DetachedAttachment = Extract<ThreadWorktreeAttachment, { state: 'detached' }>

function detachedTitle(detached: DetachedAttachment): string {
  return detached.recovery
    ? `This checkout is detached from ${detached.branch} because a ${detached.recovery} is still in progress. Finish or abort it in the thread terminal, then reattach.`
    : `This checkout is detached from ${detached.branch}. Your files are preserved. Reattach to put it back on the branch.`
}

/**
 * Branch lookups fail for a legitimately broken worktree, so they never toast —
 * but they still belong in the console, or a genuine IPC regression here would
 * leave no trace at all.
 */
function reportBranchFailure(what: string, error: unknown): void {
  console.warn(`[footer-branch-status] failed to ${what}:`, error)
}

function orderBranchesWithDefaultFirst(
  branches: GitBranchInfo[],
  defaultBranch: string | null,
): GitBranchInfo[] {
  if (!defaultBranch) return branches
  const index = branches.findIndex((branch) => branch.name === defaultBranch)
  if (index <= 0) return branches
  const ordered = branches.slice()
  const defaultEntry = ordered[index]
  if (!defaultEntry) return branches
  ordered.splice(index, 1)
  ordered.unshift(defaultEntry)
  return ordered
}

/**
 * A branch is "trunk" when it is the repo's default branch. Open PRs whose head
 * is a trunk branch (e.g. the daily main->release promotion) are incidental, so
 * we keep showing the branch name instead of replacing it with a PR link.
 */
function isTrunkBranch(branch: string | null, defaultBranch: string | null): boolean {
  return defaultBranch != null && branch != null && branch === defaultBranch
}

export function mountFooterBranchStatus(
  host: HTMLElement,
  store: AppStore,
  api: ApiClient,
): {
  destroy: () => void
  refresh: () => void
  /** The branch a blank thread was told to start from, if the user picked one. */
  pendingBaseBranch: (threadId: string) => string | undefined
} {
  const listId = `branch-picker-list-${String(++nextPickerId)}`
  const wrap = el('div', { class: 'branch-picker', hidden: '' })
  const trigger = el('button', {
    type: 'button',
    class: 'branch-picker-trigger footer-branch-status',
    'aria-label': 'Current git branch',
  })
  const label = el('span', { class: 'branch-picker-label footer-branch-label' })
  const chevron = el(
    'span',
    { class: 'branch-picker-chevron', 'aria-hidden': 'true' },
    chevronDownIcon('ui-icon ui-icon-sm'),
  )
  trigger.append(label, chevron)
  const reattachButton = el(
    'button',
    { type: 'button', class: 'branch-reattach-button', hidden: '' },
    'Reattach',
  )
  const menu = el('div', { class: 'branch-picker-menu', hidden: '' })
  const filterInput = el('input', {
    type: 'search',
    class: 'branch-picker-filter',
    placeholder: 'Filter branches...',
    'aria-label': 'Filter branches',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-controls': listId,
    'aria-expanded': 'false',
    autocomplete: 'off',
  })
  const list = el('div', {
    id: listId,
    class: 'branch-picker-list',
    role: 'listbox',
    'aria-label': 'Branches',
  })
  menu.append(filterInput, list)
  wrap.append(trigger, reattachButton, menu)
  host.append(wrap)

  let status: GitBranchStatus | null = null
  /** Set when branch status failed because the thread's own checkout lost its branch. */
  let detached: (DetachedAttachment & { threadId: string }) | null = null
  let reattaching = false
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let branchToCopy: string | null = null
  let branches: GitBranchInfo[] = []
  let defaultBranch: string | null = null
  let open = false
  let refreshToken = 0
  /** Index of the keyboard-highlighted row among the PR action (if any) plus the filtered branches. */
  let activeIndex = 0
  /**
   * Branch selections made in picker mode, per thread. A selection is a
   * statement about the thread that is about to start, not a command to move
   * the user's checkout — nothing happens on disk until the first message goes
   * through `agent:prepareCheckout`, which starts the isolated worktree from
   * this branch (or switches the shared checkout to it). Keyed by thread so
   * switching threads mid-compose cannot carry a selection across.
   */
  const baseBranchByThread = new Map<string, string>()

  function getActiveThread(): Thread | undefined {
    return getThreadById(store, store.getState().activeThreadId)
  }

  /** The picked base branch for the active thread, while it is still blank. */
  function activeBaseBranch(): string | undefined {
    const thread = getActiveThread()
    if (!thread || !isBlankThread(thread)) return undefined
    return baseBranchByThread.get(thread.id)
  }

  function getActiveThreadBranch(): string | undefined {
    return getActiveThread()?.gitBranch
  }

  function isPickerMode(): boolean {
    const thread = getActiveThread()
    return thread ? isBlankThread(thread) : false
  }

  /**
   * The branch the widget speaks for: the branch this thread will start from,
   * else the thread's binding, else the checkout.
   */
  function getDisplayBranch(): string | null {
    return activeBaseBranch() ?? getActiveThreadBranch() ?? status?.currentBranch ?? null
  }

  /**
   * The open PR worth surfacing, or null on a trunk branch. Every caller goes
   * through here so the label, the picker row and the click action can't
   * disagree about which branch they are judging.
   *
   * `status.pr` describes the branch the checkout is actually on, so a pending
   * selection that has not been acted on yet retires it rather than advertising
   * another branch's PR under this one's name.
   */
  function getVisiblePr(): GitOpenPr | null {
    const pr = status?.pr
    if (!pr) return null
    const pending = activeBaseBranch()
    if (pending && pending !== status?.currentBranch) return null
    return isTrunkBranch(getDisplayBranch(), defaultBranch) ? null : pr
  }

  function setOpen(next: boolean): void {
    open = next
    trigger.setAttribute('aria-expanded', String(next))
    filterInput.setAttribute('aria-expanded', String(next))
    if (next) {
      menu.removeAttribute('hidden')
    } else {
      menu.setAttribute('hidden', '')
      filterInput.value = ''
      activeIndex = 0
      filterInput.removeAttribute('aria-activedescendant')
    }
  }

  function renderTrigger(): void {
    const threadBranch = getActiveThreadBranch()
    const currentBranch = status?.currentBranch ?? null
    const displayBranch = getDisplayBranch()
    const pickerMode = isPickerMode()
    const pr = getVisiblePr()

    if (!displayBranch) {
      wrap.hidden = true
      branchToCopy = null
      setOpen(false)
      renderReattach()
      return
    }

    const mismatch = threadGitBranchMismatch(threadBranch, currentBranch, {
      isolatedWorktree: Boolean(getActiveThread()?.worktree),
    })
    // `mismatch` is only true when threadBranch is a non-empty string, but that
    // implication can't survive into the branches below — capture the message
    // here while threadBranch is narrowed to a defined value.
    const mismatchMessage =
      mismatch && threadBranch ? threadGitBranchMismatchMessage(threadBranch) : ''
    wrap.hidden = false
    wrap.classList.toggle('is-picker-mode', pickerMode)
    trigger.classList.toggle('is-mismatch', mismatch)
    chevron.hidden = !pickerMode
    if (pickerMode) {
      trigger.setAttribute('aria-haspopup', 'listbox')
      trigger.setAttribute('aria-expanded', String(open))
    } else {
      trigger.removeAttribute('aria-haspopup')
      trigger.removeAttribute('aria-expanded')
      setOpen(false)
    }

    if (pr) {
      label.textContent = `PR #${String(pr.number)}`
      trigger.title = mismatch ? `${mismatchMessage} (${pr.title})` : pr.title
      trigger.classList.add('is-link')
      trigger.classList.remove('is-copyable')
      branchToCopy = null
      trigger.setAttribute('aria-label', `Open pull request #${String(pr.number)}`)
    } else {
      label.textContent = displayBranch
      if (pickerMode) {
        // Picker mode names the branch this thread will start from; it is not a
        // claim about where the checkout is now, and selecting does not move it.
        const pickerLabel = `Start this thread from: ${displayBranch}`
        trigger.title = mismatch ? `${mismatchMessage} ${pickerLabel}` : pickerLabel
        trigger.classList.remove('is-link')
        trigger.classList.remove('is-copyable')
        branchToCopy = null
        trigger.setAttribute(
          'aria-label',
          mismatch ? `${mismatchMessage} ${pickerLabel}` : pickerLabel,
        )
      } else {
        trigger.title = mismatch
          ? `${mismatchMessage} Click to copy branch name.`
          : `Click to copy branch name: ${displayBranch}`
        trigger.classList.remove('is-link')
        trigger.classList.add('is-copyable')
        branchToCopy = displayBranch
        trigger.setAttribute(
          'aria-label',
          mismatch ? `${mismatchMessage} Copy branch name.` : `Copy branch name: ${displayBranch}`,
        )
      }
    }
    renderReattach()
  }

  /**
   * A detached thread checkout blocks every agent turn, so the footer offers the
   * repair next to the branch it names. The trigger keeps its copy action.
   */
  function renderReattach(): void {
    const current = activeDetached()
    const shown = current !== null && !isPickerMode() && !wrap.hidden
    reattachButton.hidden = !shown
    trigger.classList.toggle('is-detached', shown)
    if (!shown) return
    const title = detachedTitle(current)
    trigger.title = title
    reattachButton.title = title
    reattachButton.disabled = reattaching || current.recovery !== null
    reattachButton.setAttribute('aria-label', `Reattach checkout to ${current.branch}`)
    reattachButton.textContent = reattaching ? 'Reattaching…' : 'Reattach'
  }

  /** The detached state, only while it still describes the active thread. */
  function activeDetached(): DetachedAttachment | null {
    return detached?.threadId === store.getState().activeThreadId ? detached : null
  }

  async function readDetachedAttachment(
    owner: ActiveThreadOwner,
  ): Promise<DetachedAttachment | null> {
    try {
      const attachment = await api.git.worktreeAttachment(owner.projectId, owner.threadId)
      return attachment.state === 'detached' ? attachment : null
    } catch (error) {
      reportBranchFailure('inspect worktree attachment', error)
      return null
    }
  }

  async function reattach(): Promise<void> {
    const owner = getActiveThreadOwner(store)
    const current = activeDetached()
    if (!owner || !current || current.recovery || reattaching) return
    reattaching = true
    renderReattach()
    try {
      const result = await api.git.reattachWorktree(owner.projectId, owner.threadId)
      showToast(
        result.backupBranch
          ? `Reattached to ${result.branch}. Its previous tip is saved as ${result.backupBranch}.`
          : `Reattached to ${result.branch}`,
      )
      store.emit('git_branch_changed')
    } catch (error) {
      showErrorToast('Could not reattach the checkout', error)
    } finally {
      reattaching = false
      refreshNow()
    }
  }

  /** The PR action row (if any) plus the branches matching the current filter, default first. */
  function filteredRows(): { pr: GitOpenPr | null; matches: GitBranchInfo[] } {
    const pr = getVisiblePr()
    const ordered = orderBranchesWithDefaultFirst(branches, defaultBranch)
    const query = filterInput.value.trim().toLocaleLowerCase()
    const matches = query
      ? ordered.filter((branch) => branch.name.toLocaleLowerCase().includes(query))
      : ordered
    return { pr, matches }
  }

  function rowCount(): number {
    const { pr, matches } = filteredRows()
    return (pr ? 1 : 0) + matches.length
  }

  function clampActiveIndex(): void {
    const count = rowCount()
    activeIndex = count === 0 ? 0 : Math.max(0, Math.min(count - 1, activeIndex))
  }

  function scrollActiveRowIntoView(): void {
    const active = list.querySelector<HTMLElement>('.branch-picker-option.is-active')
    if (!active) return
    const activeBounds = active.getBoundingClientRect()
    const listBounds = list.getBoundingClientRect()
    if (activeBounds.top < listBounds.top) {
      list.scrollTop += activeBounds.top - listBounds.top
    } else if (activeBounds.bottom > listBounds.bottom) {
      list.scrollTop += activeBounds.bottom - listBounds.bottom
    }
  }

  /** Select the branch a thread will start from. Recording only — see the click handler below. */
  function selectBranch(name: string): void {
    setOpen(false)
    trigger.focus()
    const thread = getActiveThread()
    if (!thread) return
    // Record the choice only. Checking out here would move the user's
    // project checkout for a thread they may never send — and, when the
    // branch is held by another worktree, fail with nothing to show for it.
    baseBranchByThread.set(thread.id, name)
    renderTrigger()
    renderMenu()
  }

  /** Activate whichever row is currently keyboard-highlighted (PR action or a branch). */
  function activateRow(index: number): void {
    const { pr, matches } = filteredRows()
    if (pr && index === 0) {
      setOpen(false)
      trigger.focus()
      openBrowserUrl(store, pr.url)
      return
    }
    const branch = matches[pr ? index - 1 : index]
    if (branch) selectBranch(branch.name)
  }

  function moveActive(direction: -1 | 1): void {
    const count = rowCount()
    if (count === 0) return
    activeIndex = Math.max(0, Math.min(count - 1, activeIndex + direction))
    renderMenu()
  }

  function renderMenu(): void {
    clear(list)
    filterInput.removeAttribute('aria-activedescendant')
    if (!isPickerMode()) return

    const selected = activeBaseBranch() ?? status?.currentBranch ?? null
    const { pr, matches } = filteredRows()
    clampActiveIndex()
    let rowIndex = 0

    if (pr) {
      const prItem = el(
        'button',
        {
          type: 'button',
          class: 'branch-picker-option branch-picker-action',
          id: `${listId}-option-${String(rowIndex)}`,
          role: 'option',
          tabindex: '-1',
          'aria-selected': rowIndex === activeIndex ? 'true' : 'false',
        },
        `Open PR #${String(pr.number)}`,
      )
      if (rowIndex === activeIndex) prItem.classList.add('is-active')
      prItem.addEventListener('click', () => {
        setOpen(false)
        trigger.focus()
        openBrowserUrl(store, pr.url)
      })
      list.append(prItem)
      rowIndex++
    }

    for (const branch of matches) {
      const nameEl = el('span', { class: 'branch-picker-option-label' }, branch.name)
      const item = el(
        'button',
        {
          type: 'button',
          class: 'branch-picker-option',
          id: `${listId}-option-${String(rowIndex)}`,
          tabindex: '-1',
          role: 'option',
          // The listbox selection follows the keyboard highlight. Keep the
          // committed branch separately marked with `is-selected` below so a
          // pending choice remains visible while the user explores options.
          'aria-selected': rowIndex === activeIndex ? 'true' : 'false',
        },
        nameEl,
      )
      if (branch.name === defaultBranch) {
        item.append(el('span', { class: 'branch-picker-default-badge' }, 'default'))
      }
      if (branch.name === selected) item.classList.add('is-selected')
      if (rowIndex === activeIndex) item.classList.add('is-active')
      item.addEventListener('click', () => {
        selectBranch(branch.name)
      })
      list.append(item)
      rowIndex++
    }

    if (matches.length === 0) {
      const query = filterInput.value.trim()
      if (query) {
        list.append(el('div', { class: 'branch-picker-empty' }, `No branches match "${query}".`))
      } else if (!pr) {
        list.append(el('div', { class: 'branch-picker-empty' }, 'No branches found.'))
      }
    }
    const active = list.querySelector<HTMLElement>('.branch-picker-option.is-active')
    if (open && active) filterInput.setAttribute('aria-activedescendant', active.id)
    scrollActiveRowIntoView()
  }

  /**
   * Load the picker's branch list. `token` names the refresh generation the
   * caller started in — results from an older generation are dropped rather
   * than painted over the thread the user has since switched to.
   */
  async function loadBranches(token: number): Promise<void> {
    const owner = getActiveThreadOwner(store)
    if (!owner) return
    const [listed, defaultName] = await Promise.all([
      api.git.listBranches(owner.projectId, owner.threadId),
      api.git.getDefaultBranch(owner.projectId, owner.threadId),
    ])
    if (token !== refreshToken) return
    branches = listed
    defaultBranch = defaultName
  }

  /** A selection belongs to a blank thread; a started or deleted one drops it. */
  function pruneBaseBranches(): void {
    if (baseBranchByThread.size === 0) return
    const blank = new Set(
      store
        .getState()
        .threads.filter((thread) => isBlankThread(thread))
        .map((thread) => thread.id),
    )
    for (const threadId of baseBranchByThread.keys()) {
      if (!blank.has(threadId)) baseBranchByThread.delete(threadId)
    }
  }

  async function refresh(): Promise<void> {
    refreshedThreadId = store.getState().activeThreadId
    const token = ++refreshToken
    pruneBaseBranches()
    if (!store.getState().workspaceRoot) {
      status = null
      branches = []
      defaultBranch = null
      renderTrigger()
      return
    }
    const owner = getActiveThreadOwner(store)
    if (!owner) return
    const threadBranch = getActiveThreadBranch()
    branches = []
    defaultBranch = null
    let nextDetached: (DetachedAttachment & { threadId: string }) | null = null
    try {
      const nextStatus = await api.git.branchStatus(owner.projectId, owner.threadId, threadBranch)
      if (token !== refreshToken) return
      status = nextStatus
    } catch (error) {
      if (token !== refreshToken) return
      // Branch status is supplementary UI. A detached or externally modified
      // worktree makes the main process reject (validateThreadWorktree), and
      // the thread must stay selectable so the user can inspect and recover it.
      reportBranchFailure('read branch status', error)
      status = null
      const attachment = await readDetachedAttachment(owner)
      if (token !== refreshToken) return
      nextDetached = attachment ? { ...attachment, threadId: owner.threadId } : null
    }
    detached = nextDetached
    if (isPickerMode()) {
      try {
        await loadBranches(token)
      } catch (error) {
        if (token !== refreshToken) return
        reportBranchFailure('list branches', error)
      }
      // loadBranches awaits again, so a newer refresh can have overtaken us.
      if (token !== refreshToken) return
    } else {
      try {
        defaultBranch = await api.git.getDefaultBranch(owner.projectId, owner.threadId)
      } catch (error) {
        if (token !== refreshToken) return
        reportBranchFailure('read default branch', error)
      }
      if (token !== refreshToken) return
    }
    renderTrigger()
    if (open) renderMenu()
  }

  let refreshedThreadId = store.getState().activeThreadId

  function refreshNow(): void {
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    void refresh()
  }

  function scheduleRefresh(): void {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void refresh()
    }, 500)
  }

  /** Render store-owned state now; defer only the supplementary Git reads. */
  function scheduleStoreRefresh(): void {
    pruneBaseBranches()
    renderTrigger()
    if (open) renderMenu()
    scheduleRefresh()
  }

  function copyBranchName(): void {
    const branch = branchToCopy
    if (!branch) return
    void navigator.clipboard
      .writeText(branch)
      .then(() => showToast(COPIED_BRANCH_TOAST, { durationMs: COPY_FEEDBACK_MS }))
      .catch((error: unknown) => {
        showErrorToast('Failed to copy branch name', error)
      })
  }

  reattachButton.addEventListener('click', () => {
    void reattach()
  })

  trigger.addEventListener('click', () => {
    if (!isPickerMode()) {
      const url = getVisiblePr()?.url
      if (url) {
        openBrowserUrl(store, url)
        return
      }
      copyBranchName()
      return
    }

    const next = !open
    setOpen(next)
    if (next) {
      // Render immediately from whatever branches are already cached so the
      // filter is usable (and focusable) before the refresh below resolves.
      renderMenu()
      filterInput.focus()
      void (async (): Promise<void> => {
        const token = refreshToken
        try {
          await loadBranches(token)
        } catch (error) {
          reportBranchFailure('list branches', error)
        }
        if (token !== refreshToken) return
        renderMenu()
      })()
    }
  })

  filterInput.addEventListener('input', () => {
    activeIndex = 0
    renderMenu()
  })

  menu.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveActive(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveActive(-1)
    } else if (e.key === 'Enter' && e.target === filterInput) {
      e.preventDefault()
      activateRow(activeIndex)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      trigger.focus()
    }
  })

  const unsubs = [
    store.on('workspace_changed', refreshNow),
    store.on('threads_changed', () => {
      // A real thread switch should repaint immediately. Same-thread metadata
      // updates are the noisy path during first-message checkout and can share
      // the existing working-tree debounce.
      if (store.getState().activeThreadId !== refreshedThreadId) {
        refreshNow()
        return
      }
      scheduleStoreRefresh()
    }),
    store.on('thread_status_changed', () => {
      scheduleRefresh()
    }),
    store.on('message_added', () => {
      scheduleStoreRefresh()
    }),
    store.on('git_branch_changed', () => {
      scheduleRefresh()
    }),
    api.fs.onChanged(() => {
      scheduleRefresh()
    }),
    api.git.onWorkingTreeChanged(() => {
      scheduleRefresh()
    }),
    on(document, 'click', (e) => {
      if (!open) return
      if (!wrap.contains(e.target instanceof Node ? e.target : null)) setOpen(false)
    }),
    on(document, 'keydown', (e) => {
      if (e.key === 'Escape' && open) setOpen(false)
    }),
  ]

  void refresh()

  return {
    refresh: refreshNow,
    pendingBaseBranch: (threadId: string): string | undefined => baseBranchByThread.get(threadId),
    destroy: (): void => {
      refreshToken += 1
      if (refreshTimer) clearTimeout(refreshTimer)
      unsubs.forEach((u) => {
        u()
      })
      wrap.remove()
    },
  }
}
