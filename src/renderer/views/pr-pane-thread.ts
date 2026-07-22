import type { AppStore } from '@shared/store/store.ts'
import { createThread } from '@shared/store/thread-helpers.ts'
import type { GhPrSummary } from '@shared/types/git.ts'

export type PrDiscussRef = Pick<GhPrSummary, 'number' | 'title' | 'url'>

/** Composer draft seeded when spinning a local thread off a PR viewer. */
export function prNewThreadDraft(pr: PrDiscussRef): string {
  return `Help with [#${String(pr.number)} — ${pr.title}](${pr.url}).`
}

/** Sidebar title for a thread opened from the PR viewer. */
export function prNewThreadTitle(pr: Pick<GhPrSummary, 'number' | 'title'>): string {
  return `PR #${String(pr.number)}: ${pr.title}`
}

/**
 * Spin off a fresh local chat about `pr`: flush the current composer, open a
 * new thread with a PR-linked draft, prefer shared checkout (matching a
 * Cursor-style "Shared checkout PR #N" handoff), and leave the user in the
 * composer to edit before sending.
 *
 * Association is via the PR URL in the draft (picked up by `collectLinkedPrs`
 * once sent) — not `remoteAgentLink`, which is reserved for agent-launched PRs.
 */
export function startPrDiscussThread(store: AppStore, pr: PrDiscussRef): string {
  store.emit('composer_draft_flush')
  const threadId = createThread(store, prNewThreadDraft(pr))
  const title = prNewThreadTitle(pr)
  store.setState({
    threads: store.getState().threads.map((t) => (t.id === threadId ? { ...t, title } : t)),
  })
  store.emit('threads_changed')
  store.emit('composer_checkout_preferred', 'shared')
  return threadId
}
