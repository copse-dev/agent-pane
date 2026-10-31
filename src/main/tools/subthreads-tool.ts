import { z } from 'zod'
import { defineTool, type ToolDefinition } from '@shared/types'
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
const prompt = z.string().trim().min(1).max(100_000)
const threadId = z.string().min(1)

const subthreadParameters = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('start'),
    key: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(500),
    prompt,
  }),
  z.object({ action: z.literal('list') }),
  z.object({
    action: z.literal('read'),
    thread_id: threadId,
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  z.object({ action: z.literal('send'), thread_id: threadId, prompt }),
])

export function createSubthreadsTool(
  send: typeof sendThreadPrompt = sendThreadPrompt,
): ToolDefinition<z.infer<typeof subthreadParameters>> {
  return defineTool({
    name: 'subthreads',
    description:
      'Orchestrate your own persistent subthreads in this project. One revocable user approval covers starting children, listing their status, reading their conversations, and sending further instructions. Start uses an isolated checkout and returns the child ID and actual submission result; it does not switch the visible thread. Use a stable unique key per task: repeating start with that key returns the existing child without submitting twice. Use read to inspect results (last 20 messages by default; offset and limit page through history) and send to continue work. Child prompts use the normal queue, permissions, spend and continuation limits. Access covers only children created by this tool for you, never unrelated threads. Children do not inherit your orchestration grant. Keep delegated prompts self-contained and bounded.',
    parameters: subthreadParameters,
    async execute(args, signal) {
      const context = currentThreadExecutionContext()
      const sourceThreadId = getActiveRunThread()
      if (!sourceThreadId || !context || context.threadId !== sourceThreadId)
        return 'Subthreads require an active project thread.'
      const { projectId } = context
      const parent = await getProjectThread(projectId, sourceThreadId)
      if (!parent || parent.archivedAt !== undefined) return 'The parent thread is unavailable.'
      // Check ownership before asking: an invalid destination must never broaden consent.
      const owned = (): Owners =>
        owners().filter(
          (entry) => entry.projectId === projectId && entry.parentThreadId === sourceThreadId,
        )
      if (
        (args.action === 'read' || args.action === 'send') &&
        !owned().some((entry) => entry.threadId === args.thread_id)
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
                  title: meta.title,
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
        // Serialize per owner, including durable creation and ownership, so concurrent retries converge.
        return runSerialized(`subthreads:${projectId}:${sourceThreadId}`, async () => {
          if (!authorized()) return 'Subthread orchestration was cancelled or revoked.'
          const existing = owned().find((entry) => entry.key === args.key)
          if (existing)
            return JSON.stringify({
              thread_id: existing.threadId,
              existing: true,
              submitted: false,
              advice: 'Read the child to check its state; use send to continue it.',
            })
          const currentParent = await getProjectThread(projectId, sourceThreadId)
          if (!currentParent || currentParent.archivedAt !== undefined || !authorized())
            return 'The parent thread is unavailable or orchestration was revoked.'
          const child = { ...buildFollowUpThread(currentParent), title: args.title }
          await createThread(projectId, child)
          await updateSetting<Owners>('threadSubthreadOwners', [], (entries) => [
            ...entries,
            { projectId, parentThreadId: sourceThreadId, threadId: child.id, key: args.key },
          ])
          if (!authorized())
            return JSON.stringify({
              thread_id: child.id,
              submitted: false,
              error: 'Orchestration was cancelled or revoked before dispatch.',
            })
          const result = await send(
            { sourceThreadId, projectId, thread: child, text: args.prompt, requireWorktree: true },
            signal,
          )
          return JSON.stringify({ thread_id: child.id, ...result })
        })
      }
      const child = await getProjectThread(projectId, args.thread_id)
      if (!child || child.archivedAt !== undefined) return 'The subthread is unavailable.'
      if (!authorized()) return 'Subthread orchestration was cancelled or revoked.'
      if (args.action === 'read') {
        const limit = args.limit ?? 20
        const offset = args.offset ?? Math.max(0, child.messages.length - limit)
        return JSON.stringify({
          thread_id: child.id,
          title: child.title,
          status: child.status,
          total_messages: child.messages.length,
          offset,
          pending_messages: child.pendingMessages?.length ?? 0,
          queue_paused: child.queuePaused === true,
          messages: child.messages.slice(offset, offset + limit),
        })
      }
      const result = await send(
        {
          sourceThreadId,
          projectId,
          thread: child,
          text: args.prompt,
          requireWorktree: true,
        },
        signal,
      )
      return JSON.stringify({ thread_id: child.id, ...result })
    },
  })
}

export const subthreadsTool = createSubthreadsTool()
