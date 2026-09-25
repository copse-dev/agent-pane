import type { AppStore } from '@shared/store/store.ts'
import type { ThreadStatus } from '@shared/types'
import { getSidebarThreads, projectDisplayName } from './projects.ts'
import type { PendingApprovalSummary } from '../views/approval-dialog.ts'
import type { PendingQuestionSummary } from '../views/ask-user-dialog.ts'

/**
 * The Activity panel's data: every thread the renderer knows about, grouped by
 * its claim on the user's attention (docs/plans/mission-control.md, Job 1).
 *
 * Everything here reads thread *metadata* — id, title, status, unread mark —
 * plus the live request queues and run timings. It never reads `messages`:
 * drawing a row must not cost a transcript, which is what lets the panel list
 * threads that were only ever loaded metadata-first.
 */

/** Runtime state a row shows. Needs-you states are distinct from working, and both from settled. */
export type ActivityRowState = 'needs-approval' | 'needs-answer' | 'working' | 'failed' | 'finished'

export type ActivityGroupId = 'needs-you' | 'working' | 'recent'

/** One thread as the panel sees it — metadata only, by construction. */
export interface ActivityThread {
  id: string
  title: string
  status: ThreadStatus
  /** Latest completion that happened while the thread was not selected. */
  unreadAt?: number
  projectId: string
  projectName: string
}

/** What the renderer observed of a thread's runs this session. */
export interface RunTiming {
  /** When the current (or last) run started. */
  startedAt?: number
  /** When the last run ended; absent while it is still going. */
  endedAt?: number
  /** Latest agent activity label ("Running shell…"), null once the run settles. */
  activity?: string | null
}

export interface ActivityRow {
  /** Stable identity across renders: one row per request, or per thread. */
  key: string
  state: ActivityRowState
  threadId: string | null
  threadTitle: string
  projectId: string | null
  projectName: string | null
  /** What the thread wants (a request) or is doing — plain text, already truncated. */
  want: string
  /** The command or subject an approval is about, when it has one. */
  detail: string | null
  /** Set on needs-you rows: the pending request this row answers. */
  requestId: string | null
  /** The approval's kind (`shell`, `mcp`, …) so a command can render as code. */
  requestType: string | null
  /**
   * The approval exactly as its prompt carries it — never truncated. `want` and
   * `detail` are for scanning; this is what the user reviews before approving.
   */
  approval: PendingApprovalSummary | null
  /** Epoch the age counts from; null when the renderer never saw it start. */
  since: number | null
}

export interface ActivityGroup {
  id: ActivityGroupId
  label: string
  rows: ActivityRow[]
  /** Rows before any cap — a capped group still says how many it holds. */
  total: number
}

export interface ActivityInput {
  threads: readonly ActivityThread[]
  approvals: readonly PendingApprovalSummary[]
  questions: readonly PendingQuestionSummary[]
  runs: ReadonlyMap<string, RunTiming>
}

/** Settled rows are a reminder, not a log: the group keeps only the latest few. */
export const RECENT_ROW_LIMIT = 10
/** Long enough to identify the request; the row's own CSS ellipsis does the rest. */
export const WANT_MAX_CHARS = 140
/** Shown for a thread that has no name yet (plan: "never blank"). */
export const UNTITLED_THREAD = 'New thread'

const GROUP_LABELS: Record<ActivityGroupId, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  recent: 'Recently finished',
}

/** Collapse whitespace and cut to `max` characters with an ellipsis. */
export function truncateText(text: string, max = WANT_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

function threadName(thread: ActivityThread | undefined): string {
  const title = thread?.title.trim()
  return title && title.length > 0 ? title : UNTITLED_THREAD
}

function requestThreadFields(
  threadId: string | undefined,
  byId: ReadonlyMap<string, ActivityThread>,
): Pick<ActivityRow, 'threadId' | 'threadTitle' | 'projectId' | 'projectName'> {
  if (threadId === undefined) {
    return { threadId: null, threadTitle: 'No thread', projectId: null, projectName: null }
  }
  const thread = byId.get(threadId)
  return {
    threadId,
    threadTitle: threadName(thread),
    projectId: thread?.projectId ?? null,
    projectName: thread?.projectName ?? null,
  }
}

function questionWant(questions: readonly string[]): string {
  const first = questions[0] ?? ''
  const extra = questions.length > 1 ? ` (+${String(questions.length - 1)} more)` : ''
  return `${truncateText(first, WANT_MAX_CHARS - extra.length)}${extra}`
}

/**
 * Group and order everything the panel shows.
 *
 * Needs you comes first, longest-waiting at the top; then Working, newest run
 * first; then the recent settled runs, failures before clean finishes. A
 * thread appears once: waiting on the user outranks running.
 */
export function deriveActivity(input: ActivityInput): ActivityGroup[] {
  const byId = new Map(input.threads.map((thread) => [thread.id, thread]))

  const needsYou: ActivityRow[] = [
    ...input.approvals.map((req): ActivityRow => ({
      key: `approval:${req.id}`,
      state: 'needs-approval',
      ...requestThreadFields(req.threadId, byId),
      want: truncateText(req.title),
      detail: req.body.trim() === '' ? null : truncateText(req.body),
      requestId: req.id,
      requestType: req.type,
      approval: req,
      since: req.receivedAt,
    })),
    ...input.questions.map((req): ActivityRow => ({
      key: `question:${req.id}`,
      state: 'needs-answer',
      ...requestThreadFields(req.threadId, byId),
      want: questionWant(req.questions),
      detail: null,
      requestId: req.id,
      requestType: null,
      approval: null,
      since: req.receivedAt,
    })),
  ].sort((a, b) => (a.since ?? 0) - (b.since ?? 0))
  const waitingThreads = new Set(needsYou.flatMap((row) => (row.threadId ? [row.threadId] : [])))

  const threadRow = (
    thread: ActivityThread,
    state: ActivityRowState,
    want: string,
    since: number | null,
  ): ActivityRow => ({
    key: `thread:${thread.id}`,
    state,
    threadId: thread.id,
    threadTitle: threadName(thread),
    projectId: thread.projectId,
    projectName: thread.projectName,
    want,
    detail: null,
    requestId: null,
    requestType: null,
    approval: null,
    since,
  })

  const working: ActivityRow[] = []
  const recent: ActivityRow[] = []
  for (const thread of input.threads) {
    if (waitingThreads.has(thread.id)) continue
    const run = input.runs.get(thread.id)
    if (thread.status === 'running') {
      working.push(
        threadRow(
          thread,
          'working',
          truncateText(run?.activity ?? 'Working…'),
          run?.startedAt ?? null,
        ),
      )
    } else if (thread.status === 'error') {
      recent.push(threadRow(thread, 'failed', 'Ended with an error', run?.endedAt ?? null))
    } else {
      // A clean finish is "recent" only when something says so: this session
      // watched it end, or it completed unseen while another thread was open.
      const endedAt = run?.endedAt ?? thread.unreadAt
      if (endedAt !== undefined) recent.push(threadRow(thread, 'finished', 'Finished', endedAt))
    }
  }

  // Newest first; a run the renderer never saw start sorts after the ones it did.
  const newestFirst = (a: ActivityRow, b: ActivityRow): number =>
    (b.since ?? Number.NEGATIVE_INFINITY) - (a.since ?? Number.NEGATIVE_INFINITY) ||
    a.threadTitle.localeCompare(b.threadTitle)
  working.sort(newestFirst)
  recent.sort((a, b) => (a.state === b.state ? newestFirst(a, b) : a.state === 'failed' ? -1 : 1))

  const groups: ActivityGroup[] = [
    { id: 'needs-you', label: GROUP_LABELS['needs-you'], rows: needsYou, total: needsYou.length },
    { id: 'working', label: GROUP_LABELS.working, rows: working, total: working.length },
    {
      id: 'recent',
      label: GROUP_LABELS.recent,
      rows: recent.slice(0, RECENT_ROW_LIMIT),
      total: recent.length,
    },
  ]
  return groups
}

/**
 * Every thread the renderer currently knows about, as metadata.
 *
 * The active project's list plus each project visited this session (the
 * sidebar's own cache, compacted to rows). A carried background run replaces
 * its cached row, because the carried copy is the one still receiving status
 * changes. Projects not opened this session are absent — the sidebar has the
 * same limit (see `getSidebarThreads`).
 */
export function collectActivityThreads(store: AppStore): ActivityThread[] {
  const { projects, backgroundThreads } = store.getState()
  const out = new Map<string, ActivityThread>()
  for (const project of projects) {
    const projectName = projectDisplayName(project)
    for (const thread of getSidebarThreads(store, project.id)) {
      out.set(thread.id, {
        id: thread.id,
        title: thread.title,
        status: thread.status,
        ...(thread.unreadAt !== undefined ? { unreadAt: thread.unreadAt } : {}),
        projectId: project.id,
        projectName,
      })
    }
  }
  for (const carried of backgroundThreads) {
    const project = projects.find((p) => p.id === carried.projectId)
    if (!project || carried.thread.archivedAt != null) continue
    out.set(carried.thread.id, {
      id: carried.thread.id,
      title: carried.thread.title,
      status: carried.thread.status,
      ...(carried.thread.unreadAt !== undefined ? { unreadAt: carried.thread.unreadAt } : {}),
      projectId: project.id,
      projectName: projectDisplayName(project),
    })
  }
  return [...out.values()]
}

/**
 * Watch run starts, ends and activity labels as they happen, so the panel can
 * say how long something has been running and what it is doing without asking
 * the transcript. Returns the live map and a disposer.
 */
export function trackRunTimings(
  store: AppStore,
  now: () => number,
): { runs: ReadonlyMap<string, RunTiming>; dispose: () => void } {
  const runs = new Map<string, RunTiming>()
  const unsubs = [
    store.on('thread_status_changed', (threadId, status) => {
      const previous = runs.get(threadId)
      if (status === 'running') {
        // A status write while already running is not a new run.
        if (previous?.startedAt !== undefined && previous.endedAt === undefined) return
        runs.set(threadId, { startedAt: now() })
        return
      }
      // Only a run this session saw start can be said to have just ended; an
      // idle write for any other reason must not invent a "finished" row.
      if (
        status === 'error' ||
        (previous?.startedAt !== undefined && previous.endedAt === undefined)
      ) {
        runs.set(threadId, { ...previous, endedAt: now(), activity: null })
      }
    }),
    store.on('agent_activity', (threadId, label) => {
      const previous = runs.get(threadId)
      if (!previous || previous.endedAt !== undefined) return
      runs.set(threadId, { ...previous, activity: label })
    }),
  ]
  return {
    runs,
    dispose: (): void => {
      unsubs.forEach((unsub) => {
        unsub()
      })
    },
  }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Compact age for a row ("now", "4m", "2h", "3d"). */
export function formatAge(elapsedMs: number): string {
  if (elapsedMs < MINUTE) return 'now'
  if (elapsedMs < HOUR) return `${String(Math.floor(elapsedMs / MINUTE))}m`
  if (elapsedMs < DAY) return `${String(Math.floor(elapsedMs / HOUR))}h`
  return `${String(Math.floor(elapsedMs / DAY))}d`
}

/** The same age spelled out, for a screen reader ("4 minutes"). */
export function formatAgeLong(elapsedMs: number): string {
  const unit = (count: number, name: string): string =>
    `${String(count)} ${name}${count === 1 ? '' : 's'}`
  if (elapsedMs < MINUTE) return 'just now'
  if (elapsedMs < HOUR) return unit(Math.floor(elapsedMs / MINUTE), 'minute')
  if (elapsedMs < DAY) return unit(Math.floor(elapsedMs / HOUR), 'hour')
  return unit(Math.floor(elapsedMs / DAY), 'day')
}
