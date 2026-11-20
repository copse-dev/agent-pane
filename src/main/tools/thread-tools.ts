import { z } from 'zod'
import { defineTool, type Thread } from '@shared/types'
import { ensureThreadAccess, hasThreadAccess } from '../services/security/thread-access.ts'
import { getActiveRunThread } from '../services/active-run-identity.ts'
import { loadProjectCatalog, getProjectThread, getThreadMeta } from '../services/thread-store.ts'
import { recordArrayOrEmpty } from '@shared/unknown-value.ts'
import { storageGet } from '../services/storage/storage.ts'
import { sendThreadPrompt } from '../services/thread-prompts.ts'

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
    'Find other conversations by title and summary, newest updated first across projects. Returns up to 50 results by default; use offset and limit to page through older matches, or project_id to narrow the search. Set include_state for a compact saved brief, plan, recorded checkout and native commit/PR receipts without replaying transcripts (default 10 results, limit at most 20). Compact titles are capped at 240 characters, briefs at 1000, plans at 10 items of 240 characters with unfinished work first, receipts at the latest three of each kind; truncation and totals are explicit. Compact results omit mentioned PR lists and catalog digests. Saved status and checked-off plans are not verified task acceptance, and recorded checkout paths are not validated live ownership. First use asks permission to read all other threads; approval belongs only to this thread and never grants sending. Read the returned spine paths with read_file for detailed evidence.',
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
                hits.map((hit) => ({ projectId: id, ...hit })),
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

export const sendThreadPromptTool = defineTool({
  name: 'send_thread_prompt',
  description:
    'Send a prompt to an existing conversation. First use separately asks permission to send prompts to other threads; reading permission does not grant sending. The destination runs it when idle, or queues it behind its current work. This does not interrupt or switch the visible conversation. Write a self-contained prompt and never send to yourself.',
  parameters: z.object({
    project_id: z.string().min(1),
    thread_id: z.string().min(1),
    prompt: z.string().trim().min(1).max(100_000),
  }),
  async execute({ project_id, thread_id, prompt }, signal) {
    const sourceThreadId = getActiveRunThread()
    if (!sourceThreadId || sourceThreadId === thread_id)
      return 'Choose a different destination thread.'
    const initial = await getThreadMeta(project_id, thread_id)
    if (!initial || initial.archivedAt !== undefined)
      return 'The destination thread is unavailable.'
    if (!(await ensureThreadAccess('send', signal)))
      return 'Permission to send prompts was not granted.'
    // Consent may take minutes; re-read the destination after the user answers.
    const thread = await getProjectThread(project_id, thread_id)
    if (!thread || thread.archivedAt !== undefined) return 'The destination thread is unavailable.'
    if (signal.aborted) return 'Sending was cancelled.'
    if (!hasThreadAccess(sourceThreadId, 'send')) return 'Permission to send prompts was revoked.'
    const result = await sendThreadPrompt({
      sourceThreadId,
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
