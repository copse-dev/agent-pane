import type { BrowserWindow, IpcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs } from '../ipc/ipc-guards.ts'
import {
  SubthreadPromptHeldError,
  type ThreadPromptCommand,
  type ThreadPromptResult,
} from '@shared/thread-prompt.ts'
import { hasThreadAccess, revokeThreadAccess } from './security/thread-access.ts'
import { getSetting } from './storage/settings.ts'
import { getProjectThread, getThreadMeta } from './thread-store.ts'
import type { SettingsValues } from '@shared/settings-contract.ts'
import {
  threadPromptDispatchGrants,
  threadPromptGrantActivation,
} from './thread-prompt-dispatch-grants.ts'
import type { AgentDispatchPayload } from './agent-dispatcher.ts'
import { hasProtectedPromptMessageAppend } from './protected-prompt-receipts.ts'
import { resolveThreadExecutionContext } from './thread-execution-context.ts'

/** Main's record that `parentId` created `childId` here, and still holds orchestration. */
export function holdsSubthreadAuthorityNow(
  projectId: string,
  parentId: string,
  childId: string,
): boolean {
  const owned = getSetting<SettingsValues['threadSubthreadOwners']>(
    'threadSubthreadOwners',
    [],
  ).some(
    (entry) =>
      entry.projectId === projectId &&
      entry.parentThreadId === parentId &&
      entry.threadId === childId &&
      entry.pendingCreation !== true,
  )
  return owned && hasThreadAccess(parentId, 'orchestrate')
}

/**
 * Whether both threads exist unarchived, failing fast once authority has lapsed.
 * Callers make the final authority read after this settles.
 */
async function subthreadPairIsLive(
  projectId: string,
  parentId: string,
  childId: string,
): Promise<boolean> {
  if (!holdsSubthreadAuthorityNow(projectId, parentId, childId)) return false
  const [parent, child] = await Promise.all([
    getThreadMeta(projectId, parentId),
    getThreadMeta(projectId, childId),
  ])
  return !!parent && !!child && parent.archivedAt === undefined && child.archivedAt === undefined
}

export async function canDispatchSubthread(
  projectId: string,
  parentId: string,
  childId: string,
): Promise<boolean> {
  return (
    (await subthreadPairIsLive(projectId, parentId, childId)) &&
    holdsSubthreadAuthorityNow(projectId, parentId, childId)
  )
}

/**
 * `agent:run`'s gate for a parent's delegated prompt. The renderer's
 * `canDispatch` pre-check and its `agent:run` are separate invokes, so a revoke
 * can land between them. This rechecks after its last await and calls `start`
 * in the same synchronous step: a revoke reaches the in-memory settings from a
 * microtask, so a read even one await earlier could be overtaken. A lapsed
 * prompt rejects with `SubthreadPromptHeldError` and starts nothing.
 */
export async function dispatchSubthreadPrompt(
  projectId: string,
  parentId: string,
  childId: string,
  start: () => Promise<void>,
): Promise<void> {
  const live = await subthreadPairIsLive(projectId, parentId, childId)
  if (!live || !holdsSubthreadAuthorityNow(projectId, parentId, childId)) {
    throw new SubthreadPromptHeldError(childId)
  }
  return start()
}

type Send = (
  command: Omit<ThreadPromptCommand, 'id' | 'expiresAt'>,
  signal?: AbortSignal,
) => Promise<ThreadPromptResult>
let send: Send | null = null

export function sendThreadPrompt(
  command: Omit<ThreadPromptCommand, 'id' | 'expiresAt'>,
  signal?: AbortSignal,
): Promise<ThreadPromptResult> {
  return (
    send?.(command, signal) ??
    Promise.resolve({ ok: false, error: 'Open the desktop window to send a prompt.' })
  )
}

const replySchema = z.tuple([
  z.uuid(),
  z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), queued: z.boolean() }),
    z.strictObject({ ok: z.literal(false), error: z.string().max(2000) }),
  ]),
])

/** The renderer owns transcripts and queues; report acceptance rather than merely IPC delivery. */
export function initThreadPrompts(win: BrowserWindow, ipcMain: IpcMain): void {
  const rendererSenderId = win.webContents.id
  ipcMain.handle('thread-prompts:revoke-access', async (event, ...args) => {
    assertMainFrameSender(event, win)
    const [threadId, access] = parseIpcArgs(
      z.tuple([z.string().min(1), z.enum(['read', 'send', 'orchestrate'])]),
      args,
    )
    await revokeThreadAccess(threadId, access)
  })
  ipcMain.handle('thread-prompts:can-dispatch', async (event, ...args) => {
    assertMainFrameSender(event, win)
    const [projectId, parentId, childId] = parseIpcArgs(
      z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)]),
      args,
    )
    return canDispatchSubthread(projectId, parentId, childId)
  })
  const pending = new Map<string, (result: ThreadPromptResult) => void>()
  const canSubmit = new Map<string, () => boolean>()
  const grantCommands = new Map<string, ThreadPromptCommand>()
  ipcMain.handle('thread-prompts:can-submit', (event, ...args) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(z.uuid(), args)
    return canSubmit.get(id)?.() ?? false
  })
  ipcMain.handle('thread-prompts:activate-grant', async (event, ...args) => {
    assertMainFrameSender(event, win)
    const [id, messageId] = parseIpcArgs(z.tuple([z.uuid(), z.string().min(1).max(256)]), args)
    const command = grantCommands.get(id)
    if (
      !command ||
      command.authorizingAccess !== 'orchestrate' ||
      command.requireWorktree !== true ||
      canSubmit.get(id)?.() !== true
    ) {
      threadPromptDispatchGrants.revoke(id)
      return 'rejected' as const
    }
    try {
      const [thread, executionContext] = await Promise.all([
        getProjectThread(command.projectId, command.thread.id),
        resolveThreadExecutionContext(command.projectId, command.thread.id),
      ])
      const message = thread?.messages.find(
        (candidate) => candidate.id === messageId && candidate.role === 'user',
      )
      const exactMessage =
        message?.content === command.text &&
        (message.images?.length ?? 0) === 0 &&
        (message.attachments?.length ?? 0) === 0
      if (
        !thread ||
        executionContext.checkoutMode !== 'worktree' ||
        !exactMessage ||
        !hasProtectedPromptMessageAppend(
          rendererSenderId,
          command.projectId,
          command.thread.id,
          messageId,
        )
      ) {
        threadPromptDispatchGrants.revoke(id)
        return 'rejected' as const
      }
      const activation = threadPromptGrantActivation(thread, {
        id,
        messageId,
        sourceThreadId: command.sourceThreadId,
        content: command.text,
      })
      if (activation !== 'activated') {
        threadPromptDispatchGrants.revoke(id)
        return activation
      }
      return threadPromptDispatchGrants.activate(id, rendererSenderId, messageId)
        ? ('activated' as const)
        : ('rejected' as const)
    } catch {
      threadPromptDispatchGrants.revoke(id)
      return 'rejected' as const
    }
  })
  ipcMain.handle('thread-prompts:reply', (event, ...args) => {
    assertMainFrameSender(event, win)
    const [id, result] = parseIpcArgs(replySchema, args)
    pending.get(id)?.(result)
  })
  const sender: Send = async (command, signal) => {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve({ ok: false, error: 'Sending was cancelled.' })
        return
      }
      if (win.isDestroyed()) {
        resolve({ ok: false, error: 'The desktop window closed.' })
        return
      }
      const id = randomUUID()
      const expiresAt = Date.now() + 60_000
      const stillAuthorized = (): boolean =>
        !signal?.aborted &&
        (!command.authorizingAccess ||
          hasThreadAccess(command.sourceThreadId, command.authorizingAccess))
      if (command.authorizingAccess === 'orchestrate') {
        const payload: AgentDispatchPayload = {
          userContent: command.text,
          invokedSkills: [],
          priorTodos: [],
        }
        threadPromptDispatchGrants.mint(
          {
            id,
            senderId: rendererSenderId,
            projectId: command.projectId,
            parentThreadId: command.sourceThreadId,
            childThreadId: command.thread.id,
            content: command.text,
            payload,
          },
          stillAuthorized,
        )
        grantCommands.set(id, { ...command, id, expiresAt })
      }
      const timer = setTimeout(
        () =>
          pending.get(id)?.({
            ok: false,
            error: 'Desktop response timed out. Check the destination before retrying.',
          }),
        60_000,
      )
      const onAbort = (): void => {
        pending.get(id)?.({ ok: false, error: 'Sending was cancelled.' })
      }
      canSubmit.set(id, () => pending.has(id) && Date.now() < expiresAt && stillAuthorized())
      pending.set(id, (result) => {
        pending.delete(id)
        canSubmit.delete(id)
        grantCommands.delete(id)
        if (!result.ok) threadPromptDispatchGrants.revoke(id)
        signal?.removeEventListener('abort', onAbort)
        clearTimeout(timer)
        resolve(result)
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      win.webContents.send('thread-prompts:prompt', {
        ...command,
        id,
        expiresAt,
      } satisfies ThreadPromptCommand)
    })
  }
  send = sender
  win.once('closed', () => {
    threadPromptDispatchGrants.revokeSender(rendererSenderId)
    if (send === sender) send = null
    for (const settle of pending.values())
      settle({ ok: false, error: 'The desktop window closed.' })
    grantCommands.clear()
  })
}
