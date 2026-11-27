import { z } from 'zod'
import { defineTool, type Thread } from '@shared/types'
import {
  ensureThreadAccess,
  hasThreadAccess,
  needsOtherThreadRead,
} from '../services/security/thread-access.ts'
import { getActiveRunThread } from '../services/active-run-identity.ts'
import { getActiveRunTurnTreeId } from '../services/thread-models.ts'
import {
  loadProjectCatalog,
  getProjectThread,
  getThreadMeta,
  readThreadTranscriptPage,
  threadDirectoryPath,
  chatStoreRoot,
} from '../services/thread-store.ts'
import { recordArrayOrEmpty } from '@shared/unknown-value.ts'
import { storageGet } from '../services/storage/storage.ts'
import { sendThreadPrompt } from '../services/thread-prompts.ts'
import { rejectAutomationBudgetDelegation } from '../services/automations/automation-budget.ts'
import type { ThreadPromptCommand } from '@shared/thread-prompt.ts'

function configuredProject(id: string): Record<string, unknown> | undefined {
  return recordArrayOrEmpty(storageGet('projects')).find((project) => project['id'] === id)
}

type SavedThreadState = Pick<
  Thread,
  | 'status'
  | 'updatedAt'
  | 'workingBrief'
  | 'todos'
  | 'gitBranch'
  | 'worktree'
  | 'deferredWorktree'
  | 'commitProductions'
  | 'prProductions'
>

interface CompactText {
  text: string
  truncated: boolean
}

interface CompactThreadState {
  basis: 'stored-metadata'
  status: Thread['status']
  updatedAt: number
  brief: CompactText | null
  plan: {
    items: { content: string; status: string; truncated: boolean }[]
    total: number
    omitted: number
  }
  checkout: {
    basis: 'recorded-not-verified'
    mode: 'shared' | 'worktree' | 'deferred'
    branch: string | null
    path: string | null
    baseCommit: string | null
    retiredAt: number | null
  }
  productions: {
    commits: NonNullable<Thread['commitProductions']>
    totalCommits: number
    pullRequests: NonNullable<Thread['prProductions']>
    totalPullRequests: number
  }
}

function compactText(text: string, limit: number): CompactText {
  const before = text.charCodeAt(limit - 1)
  const after = text.charCodeAt(limit)
  const splitsPair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
  return { text: text.slice(0, splitsPair ? limit - 1 : limit), truncated: text.length > limit }
}

/** Saved coordination facts, never inferred completion or transcript/tool payloads. */
function compactThreadState(meta: SavedThreadState): CompactThreadState {
  const todos = meta.todos ?? []
  const unfinished = todos.filter(
    (todo) => todo.status === 'pending' || todo.status === 'in_progress',
  )
  const finished = todos.filter(
    (todo) => todo.status === 'completed' || todo.status === 'cancelled',
  )
  const items = [...unfinished, ...finished].slice(0, 10).map((todo) => {
    const content = compactText(todo.content, 240)
    return { content: content.text, status: todo.status, truncated: content.truncated }
  })
  const commits = meta.commitProductions ?? []
  const pullRequests = meta.prProductions ?? []
  return {
    basis: 'stored-metadata',
    status: meta.status,
    updatedAt: meta.updatedAt,
    brief: meta.workingBrief === undefined ? null : compactText(meta.workingBrief, 1000),
    plan: { items, total: todos.length, omitted: todos.length - items.length },
    checkout: {
      basis: 'recorded-not-verified',
      mode: meta.worktree ? 'worktree' : meta.deferredWorktree ? 'deferred' : 'shared',
      branch: meta.worktree?.branch ?? meta.gitBranch ?? null,
      path: meta.worktree?.path ?? null,
      baseCommit: meta.worktree?.baseCommit ?? null,
      retiredAt: meta.worktree?.retiredAt ?? null,
    },
    productions: {
      commits: commits.slice(-3),
      totalCommits: commits.length,
      pullRequests: pullRequests.slice(-3),
      totalPullRequests: pullRequests.length,
    },
  }
}

export const listThreadsTool = defineTool({
  name: 'list_threads',
  provenance: 'external',
  description:
    'Find other Copse conversations by title and summary, newest updated first across projects. Default results include project names. Returns up to 50 results by default; use offset and limit to page through older matches, or project_id to narrow the search. Set include_state for a compact saved brief, plan, recorded checkout and native commit/PR receipts without replaying transcripts (default 10 results, limit at most 20). Compact titles are capped at 240 characters, briefs at 1000, plans at 10 items of 240 characters with unfinished work first, receipts at the latest three of each kind; truncation and totals are explicit. Compact results omit mentioned PR lists and catalog digests. Saved status and checked-off plans are not verified task acceptance, and recorded checkout paths are not validated live ownership. First use asks permission to read all other threads; approval belongs only to this thread and never grants sending. Use read_thread with a returned projectId and id to read conversation text directly; spine paths remain available for detailed file reads. This catalog does not include history stored only in other apps.',
  parameters: z.object({
    query: z.string().optional(),
    project_id: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().nonnegative().optional(),
    include_state: z.boolean().optional(),
  }),
  async execute({ query, project_id, limit, offset, include_state }, signal) {
    if (include_state && limit !== undefined && limit > 20)
      return 'With include_state, choose a limit of at most 20 and use offset for older results.'
    const source = getActiveRunThread()
    if (!(await ensureThreadAccess('read', signal)))
      return 'Read access to other threads was not granted.'
    const projects = recordArrayOrEmpty(storageGet('projects'))
    const catalogs = await Promise.all(
      projects.flatMap((project) => {
        const id = project['id']
        return typeof id === 'string' && (project_id === undefined || id === project_id)
          ? [
              loadProjectCatalog(id, query).then((hits) =>
                hits.map((hit) => ({
                  ...hit,
                  projectId: id,
                  projectName: typeof project['name'] === 'string' ? project['name'] : id,
                })),
              ),
            ]
          : []
      }),
    )
    const start = offset ?? 0
    const hits = catalogs
      .flat()
      .filter((hit) => hit.id !== source)
      .sort(
        (a, b) =>
          b.updatedAt - a.updatedAt ||
          a.projectId.localeCompare(b.projectId) ||
          a.id.localeCompare(b.id),
      )
    const page = hits.slice(start, start + (limit ?? (include_state ? 10 : 50)))
    const results = include_state
      ? (
          await Promise.all(
            page.map(async (hit) => {
              const meta = await getThreadMeta(hit.projectId, hit.id)
              if (!meta || meta.archivedAt !== undefined) return null
              const title = compactText(meta.title, 240)
              return {
                projectId: hit.projectId,
                id: hit.id,
                title: title.text,
                titleTruncated: title.truncated,
                spinePath: hit.spinePath,
                state: compactThreadState(meta),
              }
            }),
          )
        ).filter((hit) => hit !== null)
      : page
    // Catalog/metadata reads can wait behind writes. Consent and caller ownership
    // must still hold when these saved facts leave the store.
    if (signal.aborted || getActiveRunThread() !== source || !hasThreadAccess(source, 'read'))
      return 'Read access was cancelled or revoked.'
    const configuredIds = new Set(
      recordArrayOrEmpty(storageGet('projects')).map((project) => project['id']),
    )
    return JSON.stringify(results.filter((hit) => configuredIds.has(hit.projectId)))
  },
})

export const readThreadTool = defineTool({
  name: 'read_thread',
  provenance: 'external',
  description:
    'Read recent stored messages from a Copse conversation returned by list_threads, resolving its stored prose directly. Returns at most 20 messages (10 by default), oldest first within the page; offset counts backward from the newest message and nextOffset requests older messages. Each body is capped at 4000 characters with an explicit truncation flag and contentPath for a detailed read_file. Tool names/statuses are summaries, not tool results. Message turnOutcome reports recorded turn completion/failure and stop reason, or null for unknown legacy outcomes; it is not task acceptance, and thread idle alone does not prove success. Active work may not have finalized yet. Uses the existing thread-scoped read consent; never grants sending or reads another app’s history.',
  parameters: z.object({
    project_id: z.string().min(1),
    thread_id: z.string().min(1),
    limit: z.number().int().min(1).max(20).default(10),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  }),
  async execute({ project_id, thread_id, limit, offset }, signal) {
    if (!configuredProject(project_id)) return 'The conversation project is unavailable.'
    const source = getActiveRunThread()
    const cancelled = (): boolean => signal.aborted
    if (!source || cancelled()) return 'Reading was cancelled or has no active conversation.'
    const other = needsOtherThreadRead(threadDirectoryPath(project_id, thread_id), chatStoreRoot())
    if (other && !(await ensureThreadAccess('read', signal)))
      return 'Read access to other threads was not granted.'
    if (!configuredProject(project_id)) return 'The conversation project is unavailable.'
    const page = await readThreadTranscriptPage(project_id, thread_id, { limit, offset })
    if (cancelled() || (other && !hasThreadAccess(source, 'read')))
      return 'Read access was cancelled or revoked.'
    const project = configuredProject(project_id)
    if (!project) return 'The conversation project is unavailable.'
    if (!page) return 'The conversation is unavailable.'
    return JSON.stringify({
      title: page.title,
      projectName: typeof project['name'] === 'string' ? project['name'] : project_id,
      status: page.status,
      messages: page.messages,
      updatedAt: page.updatedAt,
      projectId: project_id,
      threadId: thread_id,
      totalMessages: page.totalMessages,
      offset: page.offset,
      nextOffset: page.nextOffset,
    })
  },
})

/**
 * Who sends a peer prompt and which allowance it is charged to, from main's own
 * run identity, never from the tool's arguments. A run with a human root uses
 * that user turn tree, and so does a turn the ACP agent started itself, which is
 * bound to the turn tree of the task it resumes. A run without one, such as a
 * headless scheduled automation's turn or an ACP self-start in a thread no
 * dispatch gave an epoch, falls back to the sender thread (`null` in place of
 * the turn tree). Every scheduled automation run starts in a new thread, so
 * each one gets its own five prompts per destination; machine runs of one
 * thread share theirs and cannot mint more.
 * The fallback grants nothing else: it carries no turn tree, so the destination
 * inherits no epoch from it and no lease, wake or tracking is bound to it.
 */
export function peerPromptSender(): Pick<
  ThreadPromptCommand,
  'sourceThreadId' | 'sourceTurnTreeId' | 'crossThreadScope'
> | null {
  const sourceThreadId = getActiveRunThread()
  if (!sourceThreadId) return null
  const sourceTurnTreeId = getActiveRunTurnTreeId()
  return {
    sourceThreadId,
    ...(sourceTurnTreeId === null ? {} : { sourceTurnTreeId }),
    crossThreadScope: JSON.stringify([sourceThreadId, sourceTurnTreeId]),
  }
}

export const sendThreadPromptTool = defineTool({
  name: 'send_thread_prompt',
  description:
    'Send a prompt to an existing conversation. First use separately asks permission to send prompts to other threads; reading permission does not grant sending. Each user turn in this sending thread allows five prompts to each destination; a new user instruction gives a fresh allowance for every destination. The destination runs it when idle, or queues it behind its current work. This does not interrupt or switch the visible conversation. Write a self-contained prompt and never send to yourself.',
  parameters: z.object({
    project_id: z.string().min(1),
    thread_id: z.string().min(1),
    prompt: z.string().trim().min(1).max(100_000),
  }),
  async execute({ project_id, thread_id, prompt }, signal) {
    const sender = peerPromptSender()
    if (!sender || sender.sourceThreadId === thread_id)
      return 'Choose a different destination thread.'
    await rejectAutomationBudgetDelegation()
    const initial = await getThreadMeta(project_id, thread_id)
    if (!initial || initial.archivedAt !== undefined)
      return 'The destination thread is unavailable.'
    if (!(await ensureThreadAccess('send', signal)))
      return 'Permission to send prompts was not granted.'
    // Consent may take minutes; re-read the destination after the user answers.
    const thread = await getProjectThread(project_id, thread_id)
    if (!thread || thread.archivedAt !== undefined) return 'The destination thread is unavailable.'
    if (signal.aborted) return 'Sending was cancelled.'
    if (!hasThreadAccess(sender.sourceThreadId, 'send'))
      return 'Permission to send prompts was revoked.'
    const result = await sendThreadPrompt({
      ...sender,
      projectId: project_id,
      thread,
      text: prompt,
    })
    return result.ok
      ? result.queued
        ? 'Prompt queued in the destination thread.'
        : 'Prompt submitted to the destination thread.'
      : result.error
  },
})
