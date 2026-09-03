import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { openPullRequest } from './panels.ts'

/**
 * Follow a freshly opened pull request from the Changes panel to the PRs panel.
 *
 * `gh_pr_create` is the end of the review-the-diff step: the changes the panel
 * is showing have just become a pull request, and the working tree behind them
 * is now pushed and unremarkable. Staying put leaves the user reading the
 * before-picture of the thing they just asked for.
 *
 * Deliberately narrow, because seizing a pane is only welcome when the pane's
 * subject moved:
 *
 *   - Changes only. A terminal mid-command, a browser page, the file tree — each
 *     is something the user chose independently of the PR, so none is replaced.
 *   - Open only. A closed panel is a deliberate choice too; a background PR is
 *     not reason enough to reopen it over chat.
 *   - The active thread only. A background thread opening a PR must not yank the
 *     panel away from the work in front of the user; its PR chip in the sidebar
 *     is the notification it gets.
 */
export function attachPrPanelFollow(store: AppStore, api: ApiClient): () => void {
  return api.threads.onPrCreated((projectId, threadId, ref) => {
    const { activeProjectId, activeThreadId, filesPaneOpen, rightPanelMode } = store.getState()
    if (projectId !== activeProjectId || threadId !== activeThreadId) return
    if (!filesPaneOpen || rightPanelMode !== 'changes') return
    openPullRequest(store, ref)
  })
}
