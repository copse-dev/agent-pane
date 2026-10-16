import { z } from 'zod'
import { defineTool } from '@shared/types'
import { ensureThreadAccess, hasThreadAccess } from '../services/security/thread-access.ts'
import { getActiveRunThread } from '../services/active-run-identity.ts'
import { loadProjectCatalog, getProjectThread, getThreadMeta } from '../services/thread-store.ts'
import { recordArrayOrEmpty } from '@shared/unknown-value.ts'
import { storageGet } from '../services/storage/storage.ts'
import { sendThreadPrompt } from '../services/thread-prompts.ts'

export const listThreadsTool = defineTool({
  name: 'list_threads',
  description:
    'Find other conversations by title and summary. First use asks permission to read all other threads; approval belongs only to this thread. Read the returned spine paths with read_file to explore a conversation.',
  parameters: z.object({ query: z.string().optional() }),
  async execute({ query }, signal) {
    if (!(await ensureThreadAccess('read', signal)))
      return 'Read access to other threads was not granted.'
    const projects = recordArrayOrEmpty(storageGet('projects'))
    const catalogs = await Promise.all(
      projects.flatMap((project) => {
        const id = project['id']
        return typeof id === 'string'
          ? [
              loadProjectCatalog(id, query).then((hits) =>
                hits.map((hit) => ({ projectId: id, ...hit })),
              ),
            ]
          : []
      }),
    )
    return JSON.stringify(catalogs.flat().filter((hit) => hit.id !== getActiveRunThread()))
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
