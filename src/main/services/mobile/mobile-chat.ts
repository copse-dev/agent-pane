import type { BrowserWindow, IpcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs, zThreadId } from '../../ipc/ipc-guards.ts'
import type { MobileChatCommand, MobileChatResult } from '../../../shared/mobile-chat.ts'

type Submit = (command: Omit<MobileChatCommand, 'id' | 'expiresAt'>) => Promise<MobileChatResult>
let submit: Submit | null = null

export function submitMobileChat(
  command: Omit<MobileChatCommand, 'id' | 'expiresAt'>,
): Promise<MobileChatResult> {
  return (
    submit?.(command) ??
    Promise.resolve({ ok: false, error: 'Open the Copse desktop window to send a message.' })
  )
}

const replySchema = z.tuple([
  z.uuid(),
  z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), threadId: zThreadId, queued: z.boolean() }),
    z.strictObject({ ok: z.literal(false), error: z.string().max(2000) }),
  ]),
])

/** The renderer remains the sole transcript and queue writer. No IPC bridge is exposed to HTTP. */
export function initMobileChat(win: BrowserWindow, ipcMain: IpcMain): void {
  const pending = new Map<string, (result: MobileChatResult) => void>()
  ipcMain.handle('mobile:reply', (event, ...args) => {
    assertMainFrameSender(event, win)
    const [id, result] = parseIpcArgs(replySchema, args)
    pending.get(id)?.(result)
  })
  const send: Submit = (command) =>
    new Promise((resolve) => {
      if (win.isDestroyed() || pending.size > 0) {
        resolve({
          ok: false,
          error: 'The desktop is busy handling another phone message. Try again shortly.',
        })
        return
      }
      const id = randomUUID()
      const expiresAt = Date.now() + 60_000
      const timer = setTimeout(
        () =>
          pending.get(id)?.({
            ok: false,
            error: 'Desktop response timed out. Check the thread before sending again.',
          }),
        60_000,
      )
      pending.set(id, (result) => {
        pending.delete(id)
        clearTimeout(timer)
        resolve(result)
      })
      win.webContents.send('mobile:chat', { ...command, id, expiresAt } satisfies MobileChatCommand)
    })
  submit = send
  win.once('closed', () => {
    if (submit === send) submit = null
    for (const settle of pending.values())
      settle({ ok: false, error: 'The desktop window closed.' })
  })
}
