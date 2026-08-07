import { el, clear, on } from '../dom/helpers.ts'
import { chevronDownIcon } from '../dom/icons.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GitBranchInfo, GitBranchStatus } from '@shared/types/git.ts'
import type { Thread } from '@shared/types'
import {
  threadGitBranchMismatch,
  threadGitBranchMismatchMessage,
} from '@shared/git/thread-branch.ts'
import { showErrorToast, showToast } from './toast.ts'
import { getThreadById, isBlankThread } from '@shared/store/thread-helpers.ts'
import { openBrowserUrl } from '../controller/panels.ts'
import { getActiveThreadOwner } from '../controller/active-thread-owner.ts'

const COPIED_BRANCH_TOAST = 'Copied branch name'
const COPY_FEEDBACK_MS = 1600

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

export function mountFooterBranchStatus(
  host: HTMLElement,
  store: AppStore,
  api: ApiClient,
): { destroy: () => void; refresh: () => void } {
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
  const menu = el('div', { class: 'branch-picker-menu', role: 'listbox', hidden: '' })
  wrap.append(trigger, menu)
  host.append(wrap)

  let status: GitBranchStatus | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let branchToCopy: string | null = null
  let branches: GitBranchInfo[] = []
  let defaultBranch: string | null = null
  let open = false
  let refreshToken = 0

  function getActiveThread(): Thread | undefined {
    return getThreadById(store, store.getState().activeThreadId)
  }

  function getActiveThreadBranch(): string | undefined {
    return getActiveThread()?.gitBranch
  }

  function isPickerMode(): boolean {
    const thread = getActiveThread()
    return thread ? isBlankThread(thread) : false
  }

  function setOpen(next: boolean): void {
    open = next
    trigger.setAttribute('aria-expanded', String(next))
    if (next) menu.removeAttribute('hidden')
    else menu.setAttribute('hidden', '')
  }

  function renderTrigger(): void {
    const threadBranch = getActiveThreadBranch()
    const currentBranch = status?.currentBranch ?? null
    const displayBranch = threadBranch ?? currentBranch
    const pickerMode = isPickerMode()

    if (!displayBranch) {
      wrap.hidden = true
      branchToCopy = null
      setOpen(false)
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

    if (status?.pr) {
      label.textContent = `PR #${String(status.pr.number)}`
      trigger.title = mismatch ? `${mismatchMessage} (${status.pr.title})` : status.pr.title
      trigger.classList.add('is-link')
      trigger.classList.remove('is-copyable')
      branchToCopy = null
      trigger.setAttribute(
        'aria-label',
        pickerMode
          ? `Open pull request #${String(status.pr.number)}`
          : `Open pull request #${String(status.pr.number)}`,
      )
    } else {
      label.textContent = displayBranch
      if (pickerMode) {
        trigger.title = mismatch
          ? `${mismatchMessage} Switch git branch.`
          : `Switch git branch: ${displayBranch}`
        trigger.classList.remove('is-link')
        trigger.classList.remove('is-copyable')
        branchToCopy = null
        trigger.setAttribute(
          'aria-label',
          mismatch
            ? `${mismatchMessage} Switch git branch.`
            : `Switch git branch: ${displayBranch}`,
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
  }

  function renderMenu(): void {
    clear(menu)
    if (!isPickerMode()) return

    const current = status?.currentBranch ?? null

    if (status?.pr) {
      const pr = status.pr
      const prItem = el(
        'button',
        { type: 'button', class: 'branch-picker-option branch-picker-action' },
        `Open PR #${String(pr.number)}`,
      )
      prItem.addEventListener('click', () => {
        setOpen(false)
        openBrowserUrl(store, pr.url)
      })
      menu.append(prItem)
    }

    const ordered = orderBranchesWithDefaultFirst(branches, defaultBranch)
    for (const branch of ordered) {
      const nameEl = el('span', { class: 'branch-picker-option-label' }, branch.name)
      const item = el(
        'button',
        {
          type: 'button',
          class: 'branch-picker-option',
          role: 'option',
          'aria-selected': branch.name === current ? 'true' : 'false',
        },
        nameEl,
      )
      if (branch.name === defaultBranch) {
        item.append(el('span', { class: 'branch-picker-default-badge' }, 'default'))
      }
      if (branch.name === current) item.classList.add('is-selected')
      item.addEventListener('click', () => {
        if (branch.name === current) {
          setOpen(false)
          return
        }
        setOpen(false)
        const owner = getActiveThreadOwner(store)
        if (!owner) return
        void api.git.checkoutBranch(owner.projectId, owner.threadId, branch.name).then(
          () => {
            showToast(`Checked out ${branch.name}`)
            store.emit('git_branch_changed')
          },
          (error: unknown) => {
            showErrorToast(`Failed to check out ${branch.name}`, error)
          },
        )
      })
      menu.append(item)
    }

    if (ordered.length === 0 && !status?.pr) {
      menu.append(el('div', { class: 'branch-picker-empty' }, 'No branches found.'))
    }
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

  async function refresh(): Promise<void> {
    const token = ++refreshToken
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
    }
    if (isPickerMode()) {
      try {
        await loadBranches(token)
      } catch (error) {
        if (token !== refreshToken) return
        reportBranchFailure('list branches', error)
      }
      // loadBranches awaits again, so a newer refresh can have overtaken us.
      if (token !== refreshToken) return
    }
    renderTrigger()
    if (open) renderMenu()
  }

  function scheduleRefresh(): void {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => void refresh(), 500)
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

  trigger.addEventListener('click', () => {
    if (!isPickerMode()) {
      const url = status?.pr?.url
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

  const unsubs = [
    store.on('workspace_changed', () => void refresh()),
    store.on('threads_changed', () => void refresh()),
    store.on('thread_status_changed', () => {
      scheduleRefresh()
    }),
    store.on('message_added', () => void refresh()),
    store.on('git_branch_changed', () => void refresh()),
    api.fs.onChanged(() => {
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
    refresh: () => void refresh(),
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
