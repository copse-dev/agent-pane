import type { BrowserWindow, IpcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs } from '../ipc/ipc-guards.ts'
import type { ThreadPromptCommand, ThreadPromptResult } from '@shared/thread-prompt.ts'
import { hasThreadAccess, revokeThreadAccess } from './security/thread-access.ts'
import { getSetting } from './storage/settings.ts'
import { getThreadMeta } from './thread-store.ts'
import type { SettingsValues } from '@shared/settings-contract.ts'

export async function canDispatchSubthread(
  projectId: string,
  parentId: string,
  childId: string,
): Promise<boolean> {
  const owned = getSetting<SettingsValues['threadSubthreadOwners']>(
    'threadSubthreadOwners',
    [],
  ).some(
    (entry) =>
      entry.projectId === projectId &&
      entry.parentThreadId === parentId &&
      entry.threadId === childId,
  )
  if (!owned || !hasThreadAccess(parentId, 'orchestrate')) return false
  const [parent, child] = await Promise.all([
    getThreadMeta(projectId, parentId),
    getThreadMeta(projectId, childId),
  ])
  return (
    !!parent &&
    !!child &&
    parent.archivedAt === undefined &&
    child.archivedAt === undefined &&
    hasThreadAccess(parentId, 'orchestrate')
  )
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
  ipcMain.handle('thread-prompts:can-submit', (event, ...args) => {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(z.uuid(), args)
    return canSubmit.get(id)?.() ?? false
  })
  ipcMain.handle('thread-prompts:reply', (event, ...args) => {
    assertMainFrameSender(event, win)
    const [id, result] = parseIpcArgs(replySchema, args)
    pending.get(id)?.(result)
  })
  const sender: Send = (command, signal) =>
    new Promise((resolve) => {
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
      canSubmit.set(
        id,
        () =>
          pending.has(id) &&
          Date.now() < expiresAt &&
          !signal?.aborted &&
          (!command.authorizingAccess ||
            hasThreadAccess(command.sourceThreadId, command.authorizingAccess)),
      )
      pending.set(id, (result) => {
        pending.delete(id)
        canSubmit.delete(id)
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
  send = sender
  win.once('closed', () => {
    if (send === sender) send = null
    for (const settle of pending.values())
      settle({ ok: false, error: 'The desktop window closed.' })
  })
}
