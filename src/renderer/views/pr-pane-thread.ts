import type { AppStore } from '@shared/store/store.ts'
import { createThread } from '@shared/store/thread-helpers.ts'
import type { GhPrCheck, GhPrSummary } from '@shared/types/git.ts'

export type PrDiscussRef = Pick<GhPrSummary, 'number' | 'title' | 'url'>

/** Composer draft seeded when spinning a local thread off a PR viewer. */
export function prNewThreadDraft(pr: PrDiscussRef): string {
  return `Help with [#${String(pr.number)} — ${pr.title}](${pr.url}).`
}

/** Sidebar title for a thread opened from the PR viewer. */
export function prNewThreadTitle(pr: Pick<GhPrSummary, 'number' | 'title'>): string {
  return `PR #${String(pr.number)}: ${pr.title}`
}

export function prCheckFixDraft(pr: PrDiscussRef, check: GhPrCheck, headSha: string): string {
  const details =
    check.url && /^https?:\/\//i.test(check.url) ? ` Check details: ${check.url}.` : ''
  return `Fix the failing check "${check.name}" (${check.state.toLowerCase()}) on [#${String(pr.number)} — ${pr.title}](${pr.url}) at head commit ${headSha}.${details} Inspect the failure logs, identify the cause, make the fix, and run the relevant checks.`
}

function startPrThread(store: AppStore, draft: string, title: string): string {
  store.emit('composer_draft_flush')
  const threadId = createThread(store, draft)
  store.setState({
    threads: store.getState().threads.map((t) => (t.id === threadId ? { ...t, title } : t)),
  })
  store.emit('threads_changed')
  return threadId
}

export function startPrCheckFixThread(
  store: AppStore,
  pr: PrDiscussRef,
  check: GhPrCheck,
  headSha: string,
): string {
  return startPrThread(
    store,
    prCheckFixDraft(pr, check, headSha),
    `Fix PR #${String(pr.number)}: ${check.name}`,
  )
}

/**
 * Spin off a fresh local chat about `pr`: flush the current composer, open a
 * new thread with a PR-linked draft, and leave the user in the composer to edit
 * before sending. The checkout is left unset so the thread follows the regular
 * automatic policy (an isolated worktree unless the project opts out) — the
 * user can still switch it to shared from the composer footer.
 *
 * Association is via the PR URL in the draft (picked up by `collectLinkedPrs`
 * once sent) — not `remoteAgentLink`, which is reserved for agent-launched PRs.
 */
export function startPrDiscussThread(store: AppStore, pr: PrDiscussRef): string {
  return startPrThread(store, prNewThreadDraft(pr), prNewThreadTitle(pr))
}
