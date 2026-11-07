import type { Thread } from '@shared/types/thread.ts'
import type { GhPrDetails } from '@shared/types/git.ts'
import { githubPrKey, parseGithubPrUrl, type GithubPrRef } from '@shared/git/github-pr-url.ts'
import {
  ARCHIVE_DAY_MS,
  autoArchiveDays,
  threadIsInactive,
  type ThreadArchiveReview,
  type ThreadAutoArchived,
  type ThreadArchiveDecision,
} from '@shared/threads/auto-archive.ts'
import { getGhPrDetails } from './github/gh-pr-service.ts'
import { getSetting } from './storage/settings.ts'
import { storageGet } from './storage/storage.ts'
import { recordArrayOrEmpty } from '@shared/unknown-value.ts'
import { getThreadMeta, loadProjectThreadMetas, updateMetaIfUnchanged } from './thread-store.ts'
import { getProjectRoot } from './workspace.ts'
import { listStagedDiffEntries } from './diff-queue.ts'
import { hasBackgroundProcessesForThread } from './exec/background-process.ts'
import { hasTerminalSessions } from './exec/terminal-service.ts'
import { withThreadResourceFence } from './thread-resource-fence.ts'
import type { ThreadArchivingRuntime } from './thread-archiving.ts'
import { checkoutStillClean, inspectAutoArchiveCheckout } from './thread-auto-archive-git.ts'

type Meta = Omit<Thread, 'messages'>

interface AutoArchiveRuntime extends ThreadArchivingRuntime {
  isViewed(projectId: string, threadId: string): boolean
}

export interface AutoArchiveDependencies {
  now(): number
  days(): number
  root(projectId: string): string | null
  list: typeof loadProjectThreadMetas
  get: typeof getThreadMeta
  update: typeof updateMetaIfUnchanged
  /** Read the PR through the project's own checkout (`root`), not the window's. */
  pr(root: string, ref: GithubPrRef): Promise<GhPrDetails | null>
  inspect: typeof inspectAutoArchiveCheckout
  unchanged: typeof checkoutStillClean
  busy(projectId: string, threadId: string): boolean
}

const defaults: AutoArchiveDependencies = {
  now: Date.now,
  days: () => autoArchiveDays(getSetting('autoArchiveAfterDays', 3)),
  root: (projectId) => {
    const project = recordArrayOrEmpty(storageGet('projects')).find(
      (item) => item['id'] === projectId,
    )
    return project && !project['sshHost'] ? getProjectRoot(projectId) : null
  },
  list: loadProjectThreadMetas,
  get: getThreadMeta,
  update: updateMetaIfUnchanged,
  pr: getGhPrDetails,
  inspect: inspectAutoArchiveCheckout,
  unchanged: checkoutStillClean,
  busy: (projectId, threadId) =>
    hasTerminalSessions(threadId) ||
    hasBackgroundProcessesForThread({ projectId, threadId }) ||
    listStagedDiffEntries({ projectId, threadId }).length > 0,
}

function refsFor(thread: Meta): GithubPrRef[] {
  const refs = [...(thread.prRefs ?? []), ...(thread.prProductions ?? []).map((item) => item.pr)]
  const remote = thread.remoteAgentLink?.prUrl
  const parsed = remote ? parseGithubPrUrl(remote) : null
  if (parsed) refs.push(parsed)
  return [...new Map(refs.map((ref) => [githubPrKey(ref), ref])).values()]
}

/** Metadata-only soft archival. Automatic upkeep never removes a checkout or stops work. */
export class ThreadAutoArchive {
  private readonly reviews = new Map<string, ThreadArchiveReview[]>()
  private pendingSweep: Promise<void> = Promise.resolve()

  private readonly runtime: AutoArchiveRuntime
  private readonly deps: AutoArchiveDependencies

  constructor(runtime: AutoArchiveRuntime, deps: AutoArchiveDependencies = defaults) {
    this.runtime = runtime
    this.deps = deps
  }

  review(projectId: string): ThreadArchiveReview[] {
    return this.deps.days() === 0 ? [] : (this.reviews.get(projectId) ?? [])
  }

  sweep(
    projectIds: readonly string[],
    notify: (event: ThreadAutoArchived) => void,
    archive = true,
  ): Promise<void> {
    const pending = this.pendingSweep.then(() => this.runSweep(projectIds, notify, archive))
    this.pendingSweep = pending.catch(() => {})
    return pending
  }

  private async runSweep(
    projectIds: readonly string[],
    notify: (event: ThreadAutoArchived) => void,
    archive: boolean,
  ): Promise<void> {
    const days = this.deps.days()
    if (days === 0) {
      this.reviews.clear()
      return
    }
    // Bound provider reads and share identical PR lookups across projects/threads.
    const cache = new Map<string, Promise<GhPrDetails | null>>()
    for (const projectId of projectIds) {
      const reviews: ThreadArchiveReview[] = []
      this.reviews.set(projectId, reviews)
      const root = this.deps.root(projectId)
      if (!root) continue
      const threads = await this.deps.list(projectId, { includeArchived: false })
      for (const thread of threads) {
        if (!threadIsInactive(thread, this.deps.now(), days)) continue
        if (this.busy(projectId, thread.id)) continue
        const review = (reason: string): void => {
          reviews.push({ threadId: thread.id, reason })
        }
        if (
          threads.some(
            (other) => other.sideChat?.parentThreadId === thread.id && other.archivedAt == null,
          )
        ) {
          review('Archive this thread’s side chats before archiving the thread.')
          continue
        }
        const refs = refsFor(thread)
        if (!thread.worktree || refs.length === 0 || thread.prRefs === undefined) {
          review('Completion has not been verified for this thread.')
          continue
        }
        const merged: GhPrDetails[] = []
        let mergeTime = 0
        let uncertain = false
        for (const ref of refs) {
          const key = githubPrKey(ref)
          let pending = cache.get(key)
          if (!pending) {
            if (cache.size >= 40) {
              uncertain = true
              break
            }
            pending = this.deps.pr(root, ref).catch(() => null)
            cache.set(key, pending)
          }
          const pr = await pending
          const at = pr?.mergedAt ? Date.parse(pr.mergedAt) : NaN
          if (
            !pr ||
            pr.state.toUpperCase() !== 'MERGED' ||
            !Number.isFinite(at) ||
            at <= 0 ||
            at > this.deps.now()
          ) {
            uncertain = true
            break
          }
          merged.push(pr)
          mergeTime = Math.max(mergeTime, at)
        }
        if (uncertain) {
          review('Not every linked pull request has a verified merge.')
          continue
        }
        if (this.deps.now() - mergeTime < days * ARCHIVE_DAY_MS) continue
        try {
          const snapshot = await this.deps.get(projectId, thread.id)
          if (
            !snapshot ||
            snapshot.updatedAt !== thread.updatedAt ||
            !threadIsInactive(snapshot, this.deps.now(), days)
          )
            continue
          if (JSON.stringify(refsFor(snapshot)) !== JSON.stringify(refs)) continue
          const inspection = await this.deps.inspect(projectId, root, snapshot, merged)
          if (typeof inspection === 'string') {
            review(inspection)
            continue
          }
          // Returning to a thread may inspect readiness, but must never hide
          // the conversation the user just opened.
          if (!archive || this.runtime.isViewed(projectId, thread.id)) continue
          if (!this.runtime.begin(projectId, thread.id)) continue
          try {
            const archivedAt = this.deps.now()
            const archived = await withThreadResourceFence(
              { projectId, threadId: thread.id },
              async () => {
                if (!(await this.deps.unchanged(inspection.path, inspection.head))) return false
                return this.deps.update(
                  projectId,
                  thread.id,
                  snapshot,
                  { archivedAt, updatedAt: archivedAt },
                  () =>
                    this.deps.days() === days &&
                    !this.runtime.isViewed(projectId, thread.id) &&
                    !this.busy(projectId, thread.id) &&
                    threadIsInactive(snapshot, this.deps.now(), days),
                )
              },
            )
            if (archived)
              notify({ projectId, threadId: thread.id, title: snapshot.title, archivedAt })
          } finally {
            this.runtime.end(projectId, thread.id)
          }
        } catch {
          review('The checkout could not be fully verified.')
        }
      }
    }
  }

  private busy(projectId: string, threadId: string): boolean {
    return this.runtime.isAgentActive(projectId, threadId) || this.deps.busy(projectId, threadId)
  }

  /** Explicit review archives preserve local files too; restore resets the inactivity clock. */
  async decide(
    projectId: string,
    threadId: string,
    decision: ThreadArchiveDecision,
  ): Promise<boolean> {
    if (!this.runtime.begin(projectId, threadId)) return false
    try {
      return await withThreadResourceFence({ projectId, threadId }, async () => {
        const meta = await this.deps.get(projectId, threadId)
        if (!meta || meta.status === 'running' || this.busy(projectId, threadId)) return false
        if (decision === 'archive') {
          const threads = await this.deps.list(projectId, { includeArchived: false })
          if (threads.some((thread) => thread.sideChat?.parentThreadId === threadId)) return false
        }
        const now = this.deps.now()
        const archivedAt =
          decision === 'archive' ? now : decision === 'restore' ? undefined : meta.archivedAt
        const changed = await this.deps.update(
          projectId,
          threadId,
          meta,
          { archivedAt, updatedAt: now },
          () => !this.busy(projectId, threadId),
        )
        if (changed)
          this.reviews.set(
            projectId,
            this.review(projectId).filter((item) => item.threadId !== threadId),
          )
        return changed
      })
    } finally {
      this.runtime.end(projectId, threadId)
    }
  }
}
