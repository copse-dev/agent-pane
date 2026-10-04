import { el } from '../dom/helpers.ts'
import { prHasMergeConflicts } from '../dom/pr-status.ts'
import { gitMergeIcon, gitPullRequestIcon } from '../dom/icons.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GhPrChecksState } from '@shared/types/git.ts'
import { githubPrKey, type GithubPrRef } from '@shared/git/github-pr-url.ts'
import {
  describeThreadPrStatus,
  normalizePrLifecycleState,
  summarizeThreadPrStatus,
  type PrLifecycleState,
  type ThreadPrRollup,
} from '@shared/git/thread-pr-status.ts'
import { sidebarPrRefs, type SidebarThread } from '../controller/sidebar-thread.ts'

/** Re-fetch PR lifecycle when a cache entry is older than this. */
const PR_STATUS_CACHE_TTL_MS = 60_000

/**
 * Single GitHub PR icon on a thread row; color encodes open / merged / closed.
 * An open PR with merge conflicts takes the conflict glyph, which outranks a
 * failing-checks mark (#3477).
 */
export function chatPrStatus(
  rollup: ThreadPrRollup,
  ciFailing: boolean,
  conflicts: boolean,
): HTMLElement {
  const statusLabel = ciFailing
    ? `${describeThreadPrStatus(rollup)}; checks are failing`
    : describeThreadPrStatus(rollup)
  const label = conflicts ? `${statusLabel}; merge conflicts` : statusLabel
  const icon =
    rollup.kind === 'merged'
      ? gitMergeIcon('ui-icon ui-icon-sm')
      : gitPullRequestIcon('ui-icon ui-icon-sm', conflicts)
  icon.setAttribute('aria-hidden', 'true')
  return el(
    'span',
    {
      class: `chat-pr-status is-${rollup.kind}${conflicts ? ' has-conflicts' : ciFailing ? ' has-ci-failure' : ''}`,
      role: 'img',
      'aria-label': label,
      'data-tooltip': label,
    },
    icon,
  )
}

export interface PrStatusTracker {
  /** The row's PR rollup from cached lifecycles, fetching stale ones in the background. */
  rollup: (thread: SidebarThread) => ThreadPrRollup | null
  /** Whether any open PR on the row has failing checks (cached from the lifecycle fetch). */
  ciFailing: (thread: SidebarThread) => boolean
  /** Whether any open PR on the row has merge conflicts (cached from the lifecycle fetch). */
  conflicts: (thread: SidebarThread) => boolean
  /** Forget cached lifecycles, e.g. when the workspace changes. */
  reset: () => void
}

/**
 * Session cache of GitHub PR lifecycle for sidebar chips. Keys are
 * `owner/repo#number`. Fetches are coalesced; stale state stays visible while
 * revalidation runs, and lifecycle changes re-render without blocking first paint.
 */
export function createPrStatusTracker(api: ApiClient, changed: () => void): PrStatusTracker {
  const cache = new Map<
    string,
    { state: PrLifecycleState; checks?: GhPrChecksState; conflicts?: boolean; fetchedAt: number }
  >()
  const inFlight = new Set<string>()
  let generation = 0

  function isFresh(key: string): boolean {
    const entry = cache.get(key)
    return entry !== undefined && Date.now() - entry.fetchedAt <= PR_STATUS_CACHE_TTL_MS
  }

  function ensure(refs: GithubPrRef[]): void {
    const stale = refs.filter((ref) => {
      const key = githubPrKey(ref)
      return !isFresh(key) && !inFlight.has(key)
    })
    if (stale.length === 0) return
    const current = generation
    for (const ref of stale) {
      const key = githubPrKey(ref)
      let lifecycleChanged = false
      inFlight.add(key)
      void api.gh
        .prDetails(ref.owner, ref.repo, ref.number)
        .then((details) => {
          if (current !== generation) return
          const state = details ? normalizePrLifecycleState(details.state) : 'unknown'
          const previous = cache.get(key)
          const conflicts = state === 'open' && details !== null && prHasMergeConflicts(details)
          lifecycleChanged = previous?.state !== state || previous.conflicts !== conflicts
          // CI and merge conflicts only affect open PRs.
          cache.set(key, {
            state,
            conflicts,
            ...(state === 'open' && previous?.checks ? { checks: previous.checks } : {}),
            fetchedAt: Date.now(),
          })
          if (state !== 'open') return undefined
          return api.gh.prChecks(ref.owner, ref.repo, ref.number).then((checks) => {
            if (current !== generation) return
            const entry = cache.get(key)
            if (!entry) return
            if (entry.checks !== checks) lifecycleChanged = true
            cache.set(key, { ...entry, checks })
          })
        })
        .catch(() => {
          if (current !== generation) return
          const cached = cache.get(key)
          cache.set(key, {
            state: cached?.state ?? 'unknown',
            ...(cached?.conflicts !== undefined ? { conflicts: cached.conflicts } : {}),
            fetchedAt: Date.now(),
          })
        })
        .finally(() => {
          if (current !== generation) return
          inFlight.delete(key)
          if (lifecycleChanged) changed()
        })
    }
  }

  return {
    rollup: (thread: SidebarThread): ThreadPrRollup | null => {
      const refs = sidebarPrRefs(thread)
      if (refs.length === 0) return null
      ensure(refs)
      const states = refs.map((ref) => cache.get(githubPrKey(ref))?.state ?? 'unknown')
      return summarizeThreadPrStatus(states, refs)
    },
    ciFailing: (thread: SidebarThread): boolean =>
      sidebarPrRefs(thread).some((ref) => {
        const entry = cache.get(githubPrKey(ref))
        return entry?.state === 'open' && entry.checks === 'failure'
      }),
    conflicts: (thread: SidebarThread): boolean =>
      sidebarPrRefs(thread).some((ref) => {
        const entry = cache.get(githubPrKey(ref))
        return entry?.state === 'open' && entry.conflicts === true
      }),
    reset: (): void => {
      generation += 1
      cache.clear()
      inFlight.clear()
    },
  }
}

export interface PrBackfillRow {
  row: HTMLElement
  projectId: string
  threadId: string
}

export interface PrBackfill {
  /** Replace the observed rows with this render's legacy rows (no cached `prRefs`). */
  observe: (rows: readonly PrBackfillRow[]) => void
  dispose: () => void
}

/**
 * Fill legacy PR links only for rows that actually scroll into view, in
 * batches of ten per project, retrying failures with capped backoff. Results
 * arrive through `threads.onPrRefs`.
 */
export function createPrBackfill(api: ApiClient): PrBackfill {
  const requested = new Map<string, Set<string>>()
  const retryAttempts = new Map<string, number>()
  const retryTimers = new Set<ReturnType<typeof setTimeout>>()
  let rowsByKey = new Map<string, Element>()
  let observer: IntersectionObserver | null = null

  function observe(rows: readonly PrBackfillRow[]): void {
    observer?.disconnect()
    observer = null
    rowsByKey = new Map(
      rows.map(({ row, projectId, threadId }) => [`${projectId}\0${threadId}`, row]),
    )
    if (rows.length === 0 || typeof IntersectionObserver === 'undefined') return
    const rowThreads = new Map<Element, { projectId: string; threadId: string }>(
      rows.map(({ row, projectId, threadId }) => [row, { projectId, threadId }]),
    )
    const current = new IntersectionObserver((entries) => {
      if (observer !== current) return
      const pending = new Map<string, Array<{ threadId: string; row: Element }>>()
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        current.unobserve(entry.target)
        const thread = rowThreads.get(entry.target)
        if (!thread) continue
        const projectRequested = requested.get(thread.projectId) ?? new Set<string>()
        requested.set(thread.projectId, projectRequested)
        if (projectRequested.has(thread.threadId)) continue
        projectRequested.add(thread.threadId)
        const batchRows = pending.get(thread.projectId) ?? []
        batchRows.push({ threadId: thread.threadId, row: entry.target })
        pending.set(thread.projectId, batchRows)
      }
      for (const [projectId, batchRows] of pending) {
        const projectRequested = requested.get(projectId)
        for (let i = 0; i < batchRows.length; i += 10) {
          const batch = batchRows.slice(i, i + 10)
          const threadIds = batch.map(({ threadId }) => threadId)
          void api.threads
            .backfillPrRefs(projectId, threadIds)
            .then(() => {
              for (const threadId of threadIds) retryAttempts.delete(`${projectId}\0${threadId}`)
            })
            .catch((err: unknown) => {
              let attempt = 1
              for (const threadId of threadIds) {
                const key = `${projectId}\0${threadId}`
                const nextAttempt = (retryAttempts.get(key) ?? 0) + 1
                retryAttempts.set(key, nextAttempt)
                attempt = Math.max(attempt, nextAttempt)
              }
              const delay = Math.min(1_000 * 2 ** (attempt - 1), 30_000)
              const timer = setTimeout(() => {
                retryTimers.delete(timer)
                for (const { threadId } of batch) projectRequested?.delete(threadId)
                const latest = observer
                if (!latest) return
                for (const { threadId } of batch) {
                  const row = rowsByKey.get(`${projectId}\0${threadId}`)
                  if (row?.isConnected) latest.observe(row)
                }
              }, delay)
              retryTimers.add(timer)
              console.warn('[threads] visible PR-ref backfill failed:', err)
            })
        }
      }
    })
    observer = current
    for (const { row } of rows) current.observe(row)
  }

  return {
    observe,
    dispose: (): void => {
      for (const timer of retryTimers) clearTimeout(timer)
      retryTimers.clear()
      observer?.disconnect()
      observer = null
      rowsByKey.clear()
    },
  }
}
