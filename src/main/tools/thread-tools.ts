import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  ensureThreadAccess,
  hasThreadAccess,
  needsOtherThreadRead,
} from '../services/security/thread-access.ts'
import { getActiveRunThread } from '../services/active-run-identity.ts'
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

function configuredProject(id: string): Record<string, unknown> | undefined {
  return recordArrayOrEmpty(storageGet('projects')).find((project) => project['id'] === id)
}

export const listThreadsTool = defineTool({
  name: 'list_threads',
  provenance: 'external',
  description:
    'Find other Copse conversations by title and summary, newest updated first across projects, including project names. Returns up to 50 results by default; use offset and limit to page through older matches, or project_id to narrow the search. First use asks permission to read all other threads; approval belongs only to this thread. Use read_thread with a returned projectId and id to read conversation text directly; spine paths remain available for detailed file reads. This catalog does not include history stored only in other apps.',
  parameters: z.object({
    query: z.string().optional(),
    project_id: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().nonnegative().optional(),
  }),
  async execute({ query, project_id, limit, offset }, signal) {
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
      .filter((hit) => hit.id !== getActiveRunThread())
      .sort(
        (a, b) =>
          b.updatedAt - a.updatedAt ||
          a.projectId.localeCompare(b.projectId) ||
          a.id.localeCompare(b.id),
      )
    return JSON.stringify(hits.slice(start, start + (limit ?? 50)))
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
