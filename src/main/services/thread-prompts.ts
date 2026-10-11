import type { BrowserWindow, IpcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs } from '../ipc/ipc-guards.ts'
import type { ThreadPromptCommand, ThreadPromptResult } from '@shared/thread-prompt.ts'
import { revokeThreadAccess } from './security/thread-access.ts'

type Send = (command: Omit<ThreadPromptCommand, 'id' | 'expiresAt'>) => Promise<ThreadPromptResult>
let send: Send | null = null

export function sendThreadPrompt(
  command: Omit<ThreadPromptCommand, 'id' | 'expiresAt'>,
): Promise<ThreadPromptResult> {
  return (
    send?.(command) ??
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
      z.tuple([z.string().min(1), z.enum(['read', 'send'])]),
      args,
    )
    await revokeThreadAccess(threadId, access)
  })
  const pending = new Map<string, (result: ThreadPromptResult) => void>()
  ipcMain.handle('thread-prompts:reply', (event, ...args) => {
    assertMainFrameSender(event, win)
    const [id, result] = parseIpcArgs(replySchema, args)
    pending.get(id)?.(result)
  })
  const sender: Send = (command) =>
    new Promise((resolve) => {
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
      pending.set(id, (result) => {
        pending.delete(id)
        clearTimeout(timer)
        resolve(result)
      })
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
