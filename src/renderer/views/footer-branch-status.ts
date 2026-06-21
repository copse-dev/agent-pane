import { el } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GitBranchStatus } from '@shared/types/git.ts'

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

  function render() {
    if (!status?.branch) {
      root.hidden = true
      return
    }

    root.hidden = false
    if (status.pr) {
      label.textContent = `PR #${status.pr.number}`
      root.title = status.pr.title
      root.classList.add('is-link')
      root.setAttribute('aria-label', `Open pull request #${status.pr.number}`)
    } else {
      label.textContent = status.branch
      root.title = status.branch
      root.classList.remove('is-link')
      root.setAttribute('aria-label', `Current branch: ${status.branch}`)
    }
  }

  async function refresh() {
    if (!store.getState().workspaceRoot) {
      status = null
      render()
      return
    }
    status = await api.git.branchStatus()
    render()
  }

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => void refresh(), 500)
  }

  root.addEventListener('click', () => {
    const url = status?.pr?.url
    if (url) void api.shell.openExternal(url)
  })

  const unsubs = [
    store.on('workspace_changed', () => void refresh()),
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
