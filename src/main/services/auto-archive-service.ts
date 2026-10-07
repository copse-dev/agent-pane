/**
 * Archives threads whose work has landed, so a long-running Copse does not
 * leave the sidebar full of finished conversations (#3330).
 *
 * Lives in main because every fact the decision needs is here — the thread
 * store, the linked checkout's git state, the proposed-diff queue, the running
 * set, the GitHub PR lookup — and because it must reach every project, not just
 * the one the renderer has open. The rule itself is the pure
 * `selectAutoArchivable`; this module gathers its inputs and applies the result.
 *
 * Archiving is a soft-hide (`archivedAt`), so the sweep errs toward leaving a
 * thread alone: a fact it cannot establish is reported as unknown and blocks.
 */
import { access } from 'node:fs/promises'
import { githubPrKey, type GithubPrRef } from '@shared/git/github-pr-url.ts'
import { normalizePrLifecycleState, type PrLifecycleState } from '@shared/git/thread-pr-status.ts'
import {
  DAY_MS,
  selectAutoArchivable,
  type AutoArchiveCandidate,
} from '@shared/store/auto-archive.ts'
import type { Thread } from '@shared/types'
import type { ThreadMeta } from '@shared/threads/spine-schema.ts'

/** Ceiling on GitHub lookups per sweep; the local checks run first and cull most threads. */
const MAX_PR_LOOKUPS_PER_SWEEP = 40

export interface PrSnapshot {
  state: PrLifecycleState
  /** ms epoch of the PR's last update — for a merged PR, effectively its merge time. */
  updatedAt: number | null
}

export interface WorktreeFacts {
  changedFiles: number | null
  unpushedCommits: number | null
}

export interface AutoArchiveProject {
  id: string
  path: string
  /** SSH workspaces have no local checkout to inspect; they are skipped. */
  sshHost?: string
}

export interface AutoArchiveDeps {
  afterDays: () => number
  projects: () => AutoArchiveProject[]
  loadThreads: (projectId: string) => Promise<Thread[]>
  runningThreadIds: () => ReadonlySet<string>
  isActive: (projectId: string, threadId: string) => boolean
  stagedDiffCount: (projectId: string, threadId: string) => number
  prSnapshot: (ref: GithubPrRef) => Promise<PrSnapshot>
  worktreeFacts: (project: AutoArchiveProject, thread: Thread) => Promise<WorktreeFacts>
  /** Evaluate the synchronous condition against current metadata inside the write queue. */
  archive: (
    projectId: string,
    threadId: string,
    now: number,
    condition: (current: ThreadMeta) => boolean,
  ) => Promise<boolean>
  now: () => number
}

export interface AutoArchiveSweepResult {
  /** Thread ids archived, by project. */
  archived: { projectId: string; threadIds: string[] }[]
}

/**
 * Cheap, local-only screen. Anything that fails here never costs a GitHub
 * request or a git invocation. Shared-checkout threads are excluded outright:
 * their "worktree" is the project directory, so its dirtiness cannot be
 * attributed to the thread.
 */
function isWorthInspecting(
  thread: ThreadMeta,
  running: ReadonlySet<string>,
  now: number,
  afterMs: number,
): boolean {
  if (thread.archivedAt != null || thread.status !== 'idle' || running.has(thread.id)) return false
  if (thread.unreadAt != null) return false
  if (thread.worktree === undefined) return false
  if ((thread.prRefs ?? []).length === 0) return false
  return now - thread.updatedAt >= afterMs
}

export async function runAutoArchiveSweep(deps: AutoArchiveDeps): Promise<AutoArchiveSweepResult> {
  const days = deps.afterDays()
  const result: AutoArchiveSweepResult = { archived: [] }
  if (!(days > 0)) return result
  const afterMs = days * DAY_MS
  const now = deps.now()
  const running = deps.runningThreadIds()
  const prCache = new Map<string, Promise<PrSnapshot>>()
  let lookups = 0

  const snapshot = (ref: GithubPrRef): Promise<PrSnapshot> => {
    const key = githubPrKey(ref)
    let pending = prCache.get(key)
    if (pending === undefined) {
      lookups += 1
      pending = deps
        .prSnapshot(ref)
        .catch((): PrSnapshot => ({ state: 'unknown', updatedAt: null }))
      prCache.set(key, pending)
    }
    return pending
  }

  for (const project of deps.projects()) {
    if (project.sshHost !== undefined) continue
    const threads = await deps.loadThreads(project.id).catch((): Thread[] => [])
    const candidates: AutoArchiveCandidate[] = []
    const conditions = new Map<string, (current: ThreadMeta) => boolean>()
    for (const thread of threads) {
      if (!isWorthInspecting(thread, running, now, afterMs) || deps.isActive(project.id, thread.id))
        continue
      // Capture the inspected identity before any awaits. Cached thread objects can
      // also change in place; facts for an old checkout or PR set cannot authorize it.
      const updatedAt = thread.updatedAt
      const checkout = JSON.stringify(thread.worktree)
      const refs = thread.prRefs ?? []
      const refKeys = refs.map(githubPrKey).join('\n')
      if (lookups + refs.length > MAX_PR_LOOKUPS_PER_SWEEP) continue
      const snapshots = await Promise.all(refs.map(snapshot))
      // Cheapest remaining gate first: don't shell out to git for an open PR.
      if (snapshots.some((s) => s.state !== 'merged')) continue
      const facts = await deps.worktreeFacts(project, thread)
      conditions.set(
        thread.id,
        (current) =>
          deps.afterDays() === days &&
          !deps.isActive(project.id, current.id) &&
          isWorthInspecting(current, deps.runningThreadIds(), deps.now(), afterMs) &&
          current.updatedAt === updatedAt &&
          JSON.stringify(current.worktree) === checkout &&
          (current.prRefs ?? []).map(githubPrKey).join('\n') === refKeys &&
          deps.stagedDiffCount(project.id, current.id) === 0,
      )
      candidates.push({
        id: thread.id,
        prStates: snapshots.map((s) => s.state),
        lastActivityAt: Math.max(thread.updatedAt, ...snapshots.map((s) => s.updatedAt ?? 0)),
        running: false,
        active: false,
        needsAttention: false,
        pendingStagedDiffs: deps.stagedDiffCount(project.id, thread.id),
        changedFiles: facts.changedFiles,
        unpushedCommits: facts.unpushedCommits,
      })
    }
    const ids = selectAutoArchivable(candidates, { now, afterMs })
    const archived: string[] = []
    for (const id of ids) {
      const condition = conditions.get(id)
      if (condition && (await deps.archive(project.id, id, now, condition))) archived.push(id)
    }
    if (archived.length > 0) result.archived.push({ projectId: project.id, threadIds: archived })
  }
  return result
}

/** Real-world PR lookup: lifecycle and last-update time from GitHub details. */
export function snapshotFromDetails(
  details: { state: string; updatedAt?: string } | null,
): PrSnapshot {
  if (details === null) return { state: 'unknown', updatedAt: null }
  const parsed = details.updatedAt ? Date.parse(details.updatedAt) : Number.NaN
  return {
    state: normalizePrLifecycleState(details.state),
    updatedAt: Number.isFinite(parsed) ? parsed : null,
  }
}

/**
 * Git facts about a thread's linked checkout. A checkout that has already been
 * removed holds nothing to lose. Ignored files (node_modules, build output) are
 * deliberately not counted: archiving leaves the directory alone, unlike the
 * worktree cleanup that does delete it.
 */
export async function inspectThreadWorktree(
  thread: Thread,
  git: (cwd: string, args: string[]) => Promise<{ stdout: string; code: number }>,
): Promise<WorktreeFacts> {
  const path = thread.worktree?.path
  if (path === undefined) return { changedFiles: null, unpushedCommits: null }
  const present = await access(path).then(
    () => true,
    () => false,
  )
  if (!present) return { changedFiles: 0, unpushedCommits: 0 }

  const [status, unpushed] = await Promise.all([
    git(path, ['status', '--porcelain=v1', '-z']).catch(() => null),
    // Commits no remote-tracking ref contains: survives a deleted upstream
    // branch, which is the normal state after a PR merges.
    git(path, ['rev-list', '--count', 'HEAD', '--not', '--remotes']).catch(() => null),
  ])
  const changed =
    status !== null && status.code === 0 ? status.stdout.split('\0').filter(Boolean).length : null
  const ahead =
    unpushed !== null && unpushed.code === 0 ? Number.parseInt(unpushed.stdout, 10) : Number.NaN
  return { changedFiles: changed, unpushedCommits: Number.isNaN(ahead) ? null : ahead }
}
