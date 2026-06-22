import { el } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GitBranchStatus } from '@shared/types/git.ts'
import {
  threadGitBranchMismatch,
  threadGitBranchMismatchMessage,
} from '@shared/git/thread-branch.ts'
import { showErrorToast, showToast } from './toast.ts'

const COPIED_BRANCH_TOAST = 'Copied branch name'
const COPY_FEEDBACK_MS = 1600

export function mountFooterBranchStatus(
  host: HTMLElement,
  store: AppStore,
  api: ApiClient,
): () => void {
  const label = el('span', { class: 'footer-branch-label' })
  const root = el(
    'button',
    {
      type: 'button',
      class: 'footer-branch-status',
      hidden: 'true',
      'aria-label': 'Current git branch',
    },
    label,
  )
  host.append(root)

  let status: GitBranchStatus | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let branchToCopy: string | null = null

  function getActiveThreadBranch(): string | undefined {
    const id = store.getState().activeThreadId
    const thread = store.getState().threads.find((t) => t.id === id)
    return thread?.gitBranch
  }

  function render() {
    const threadBranch = getActiveThreadBranch()
    const currentBranch = status?.currentBranch ?? null
    const displayBranch = threadBranch ?? currentBranch

    if (!displayBranch) {
      root.hidden = true
      branchToCopy = null
      return
    }

    const mismatch = threadGitBranchMismatch(threadBranch, currentBranch)
    root.hidden = false
    root.classList.toggle('is-mismatch', mismatch)

    if (status?.pr) {
      label.textContent = `PR #${status.pr.number}`
      root.title = mismatch
        ? `${threadGitBranchMismatchMessage(threadBranch!)} (${status.pr.title})`
        : status.pr.title
      root.classList.add('is-link')
      root.classList.remove('is-copyable')
      branchToCopy = null
      root.setAttribute('aria-label', `Open pull request #${status.pr.number}`)
    } else {
      label.textContent = displayBranch
      root.title = mismatch
        ? `${threadGitBranchMismatchMessage(threadBranch!)} Click to copy branch name.`
        : `Click to copy branch name: ${displayBranch}`
      root.classList.remove('is-link')
      root.classList.add('is-copyable')
      branchToCopy = displayBranch
      root.setAttribute(
        'aria-label',
        mismatch
          ? `${threadGitBranchMismatchMessage(threadBranch!)} Copy branch name.`
          : `Copy branch name: ${displayBranch}`,
      )
    }
  }

  async function refresh() {
    if (!store.getState().workspaceRoot) {
      status = null
      render()
      return
    }
    const threadBranch = getActiveThreadBranch()
    status = await api.git.branchStatus(threadBranch)
    render()
  }

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => void refresh(), 500)
  }

  root.addEventListener('click', () => {
    const url = status?.pr?.url
    if (url) {
      void api.shell.openExternal(url)
      return
    }

    const branch = branchToCopy
    if (!branch) return

    void navigator.clipboard
      .writeText(branch)
      .then(() => showToast(COPIED_BRANCH_TOAST, { durationMs: COPY_FEEDBACK_MS }))
      .catch((error: unknown) => showErrorToast('Failed to copy branch name', error))
  })

  const unsubs = [
    store.on('workspace_changed', () => void refresh()),
    store.on('threads_changed', () => void refresh()),
    store.on('thread_status_changed', () => scheduleRefresh()),
    api.fs.onChanged(() => scheduleRefresh()),
  ]

  void refresh()

  return () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    unsubs.forEach((u) => u())
    root.remove()
  }
}
