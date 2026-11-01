import { z } from 'zod'
import { defineTool, type ToolDefinition, type Thread } from '@shared/types'
import type { SettingsValues } from '@shared/settings-contract.ts'
import { buildFollowUpThread } from '@copse/thread-store/follow-up-thread.ts'
import { getActiveRunThread } from '../services/active-run-identity.ts'
import { currentThreadExecutionContext } from '../services/thread-execution-context-store.ts'
import { createThread, getProjectThread, getThreadMeta } from '../services/thread-store.ts'
import { getSetting, updateSetting } from '../services/storage/settings.ts'
import { runSerialized } from '../services/storage/write-queue.ts'
import { ensureThreadAccess, hasThreadAccess } from '../services/security/thread-access.ts'
import { sendThreadPrompt } from '../services/thread-prompts.ts'

type Owners = SettingsValues['threadSubthreadOwners']
const owners = (): Owners => getSetting<Owners>('threadSubthreadOwners', [])
const MAX_STARTS = 4
const MAX_LIVE_CHILDREN = 2
const READ_BYTES = 24_000

// MCP and native providers require an object at the schema root.
const subthreadParameters = z.object({
  action: z.enum(['start', 'list', 'read', 'send']),
  key: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(500).optional(),
  prompt: z.string().trim().min(1).max(100_000).optional(),
  thread_id: z.string().min(1).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

function readMessages(messages: Thread['messages']): Array<{ role: string; content: string }> {
  let remaining = READ_BYTES
  const projected = []
  for (const message of messages) {
    // Tool payloads, reasoning, attachments and contentBlocks never cross this boundary.
    const content = message.content
    const clipped = Buffer.from(content).subarray(0, Math.min(remaining, 2000)).toString('utf8')
    remaining -= Buffer.byteLength(clipped) + 100
    if (remaining < 0) break
    projected.push({
      role: message.role,
      content: clipped.replace(/data:image\/[^\s)]+/g, '[image omitted]'),
    })
  }
  return projected
}

export function createSubthreadsTool(
  send: typeof sendThreadPrompt = sendThreadPrompt,
): ToolDefinition<z.infer<typeof subthreadParameters>> {
  return defineTool({
    name: 'subthreads',
    description:
      'Orchestrate your own persistent children in this project with one revocable approval. At most four child starts are allowed for this parent, with at most two unarchived children; children cannot orchestrate nested children. Use start with key, title and prompt; list for status; read with thread_id and optional offset/limit for capped text excerpts; send with thread_id and prompt to continue a child. A stable key avoids duplicate starts; an unavailable child may be replaced within the same start limit. Children use isolated checkouts and their own normal continuation budgets, queue and permissions. They do not inherit your grants. Prompts must be self-contained and bounded.',
    parameters: subthreadParameters,
    async execute(args, signal) {
      const key = args.key ?? ''
      const title = args.title ?? ''
      const text = args.prompt ?? ''
      const destination = args.thread_id ?? ''
      if (args.action === 'start' && (!key || !title || !text))
        return 'start requires key, title and prompt.'
      if ((args.action === 'read' || args.action === 'send') && !destination)
        return 'read and send require thread_id.'
      if (args.action === 'send' && !text) return 'send requires prompt.'
      const context = currentThreadExecutionContext()
      const sourceThreadId = getActiveRunThread()
      if (!sourceThreadId || !context || context.threadId !== sourceThreadId)
        return 'Subthreads require an active project thread.'
      const { projectId } = context
      if (
        owners().some((entry) => entry.projectId === projectId && entry.threadId === sourceThreadId)
      )
        return 'A subthread cannot orchestrate nested subthreads.'
      const parent = await getProjectThread(projectId, sourceThreadId)
      if (!parent || parent.archivedAt !== undefined) return 'The parent thread is unavailable.'
      const owned = (): Owners =>
        owners().filter(
          (entry) => entry.projectId === projectId && entry.parentThreadId === sourceThreadId,
        )
      if (
        (args.action === 'read' || args.action === 'send') &&
        !owned().some((entry) => entry.threadId === destination)
      )
        return 'That thread is not one of your subthreads.'
      if (!(await ensureThreadAccess('orchestrate', signal)))
        return 'Subthread orchestration was not granted.'
      const authorized = (): boolean =>
        !signal.aborted && hasThreadAccess(sourceThreadId, 'orchestrate')
      if (!authorized()) return 'Subthread orchestration was cancelled or revoked.'

      if (args.action === 'list') {
        const entries = await Promise.all(
          owned().map(async (entry) => {
            const meta = await getThreadMeta(projectId, entry.threadId)
            return meta
              ? {
                  thread_id: entry.threadId,
                  key: entry.key,
                  title: meta.title.slice(0, 500),
                  status: meta.status,
                  archived: meta.archivedAt !== undefined,
                }
              : null
          }),
        )
        return authorized()
          ? JSON.stringify(entries.filter((entry) => entry !== null))
          : 'Subthread orchestration was revoked.'
      }
      if (args.action === 'start') {
        const prepared = await runSerialized(
          `subthreads:${projectId}:${sourceThreadId}`,
          async (): Promise<{ child: Thread | null; result: string }> => {
            if (!authorized())
              return { child: null, result: 'Subthread orchestration was cancelled or revoked.' }
            const entries = owned()
            const existing = entries.findLast((entry) => entry.key === key)
            if (existing) {
              const meta = await getThreadMeta(projectId, existing.threadId)
              if (meta && meta.archivedAt === undefined)
                return {
                  child: null,
                  result: JSON.stringify({
                    thread_id: existing.threadId,
                    existing: true,
                    submitted: false,
                  }),
                }
            }
            if (entries.length >= MAX_STARTS)
              return {
                child: null,
                result:
                  'This parent has reached its four child starts. Ask the user to start a new parent thread.',
              }
            const metas = await Promise.all(
              entries.map((entry) => getThreadMeta(projectId, entry.threadId)),
            )
            if (
              metas.filter((meta) => meta && meta.archivedAt === undefined).length >=
              MAX_LIVE_CHILDREN
            )
              return {
                child: null,
                result:
                  'This parent already has two live children. Archive a finished child before starting another.',
              }
            const currentParent = await getProjectThread(projectId, sourceThreadId)
            if (!currentParent || currentParent.archivedAt !== undefined || !authorized())
              return {
                child: null,
                result: 'The parent thread is unavailable or orchestration was revoked.',
              }
            // Delegation does not implicitly authorize reading the parent's transcript.
            const { followUpOf: _parentAccess, ...child } = {
              ...buildFollowUpThread(currentParent),
              title,
            }
            await createThread(projectId, child)
            await updateSetting<Owners>('threadSubthreadOwners', [], (all) => [
              ...all,
              {
                projectId,
                parentThreadId: sourceThreadId,
                threadId: child.id,
                key,
              },
            ])
            return { child, result: '' }
          },
        )
        if (!prepared.child) return prepared.result
        if (!authorized())
          return JSON.stringify({
            thread_id: prepared.child.id,
            submitted: false,
            error: 'Orchestration was cancelled or revoked before dispatch.',
          })
        // Never hold the persistence lane while waiting for the desktop response.
        const result = await send(
          {
            sourceThreadId,
            projectId,
            thread: prepared.child,
            text,
            requireWorktree: true,
            authorizingAccess: 'orchestrate',
          },
          signal,
        )
        return JSON.stringify({ thread_id: prepared.child.id, ...result })
      }
      const child = await getProjectThread(projectId, destination)
      if (!child || child.archivedAt !== undefined) return 'The subthread is unavailable.'
      if (!authorized()) return 'Subthread orchestration was cancelled or revoked.'
      if (args.action === 'read') {
        const limit = args.limit ?? 20
        const offset = args.offset ?? Math.max(0, child.messages.length - limit)
        return JSON.stringify({
          thread_id: child.id,
          title: child.title.slice(0, 500),
          status: child.status,
          total_messages: child.messages.length,
          offset,
          pending_messages: child.pendingMessages?.length ?? 0,
          queue_paused: child.queuePaused === true,
          messages: readMessages(child.messages.slice(offset, offset + limit)),
        })
      }
      const result = await send(
        {
          sourceThreadId,
          projectId,
          thread: child,
          text,
          requireWorktree: true,
          authorizingAccess: 'orchestrate',
        },
        signal,
      )
      return JSON.stringify({ thread_id: child.id, ...result })
    },
  })
}

export const subthreadsTool = createSubthreadsTool()
