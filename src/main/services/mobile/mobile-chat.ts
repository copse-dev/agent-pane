import type { BrowserWindow, IpcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs, zThreadId } from '../../ipc/ipc-guards.ts'
import type {
  MobileChatCommand,
  MobileChatRequest,
  MobileChatResult,
} from '../../../shared/mobile-chat.ts'
import { getLatestThreadPlan, getProjectThread, loadAgentHistory } from '../thread-store.ts'
import { getSettingsSnapshot } from '../storage/settings-transaction.ts'
import { mobilePromptGrants } from './mobile-prompt-grants.ts'

type Submit = (
  command: MobileChatRequest,
  stillAuthorized: () => boolean,
) => Promise<MobileChatResult>
let submit: Submit | null = null

export function submitMobileChat(
  command: MobileChatRequest,
  stillAuthorized: () => boolean,
): Promise<MobileChatResult> {
  return (
    submit?.(command, stillAuthorized) ??
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
  const rendererSenderId = win.webContents.id
  ipcMain.handle('mobile:reply', (event, ...args) => {
    assertMainFrameSender(event, win)
    const [id, result] = parseIpcArgs(replySchema, args)
    pending.get(id)?.(result)
  })
  const send: Submit = async (command, stillAuthorized) => {
    if (win.isDestroyed() || pending.size > 0)
      return {
        ok: false,
        error: 'The desktop is busy handling another phone message. Try again shortly.',
      }
    const id = randomUUID()
    const threadId = command.threadId ?? randomUUID()
    const createThread = command.threadId === null
    const [thread, history, plan] = createThread
      ? [null, [], null]
      : await Promise.all([
          getProjectThread(command.projectId, threadId),
          loadAgentHistory(command.projectId, threadId),
          getLatestThreadPlan(command.projectId, threadId),
        ])
    // Plan creation and approval are still renderer-authored. Unlike the
    // desktop protected window, Mobile Companion cannot show that full context
    // for native review, so it must not silently inherit plan authority.
    if (plan && plan.meta.status !== 'abandoned')
      return {
        ok: false,
        error: 'Open this planned thread on the desktop to review its full prompt context.',
      }
    if (!stillAuthorized())
      return { ok: false, error: 'Phone control was disabled before the message was admitted.' }
    const model = thread?.model ?? getSettingsSnapshot().model
    const expiresAt = Date.now() + 60_000
    const content = command.image
      ? [
          { type: 'image' as const, dataUrl: command.image },
          { type: 'text' as const, text: command.text || 'Please look at this image.' },
        ]
      : command.text || 'Please look at this image.'
    mobilePromptGrants.mint(
      {
        id,
        senderId: rendererSenderId,
        projectId: command.projectId,
        threadId,
        content,
        history,
        ...(model !== undefined ? { model } : {}),
        expiresAt,
      },
      stillAuthorized,
    )
    const delivery: MobileChatCommand = {
      ...command,
      id,
      threadId,
      createThread,
      ...(model !== undefined ? { model } : {}),
      expiresAt,
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        mobilePromptGrants.revoke(id)
        pending.get(id)?.({
          ok: false,
          error: 'Desktop response timed out. Check the thread before sending again.',
        })
      }, 60_000)
      pending.set(id, (result) => {
        pending.delete(id)
        clearTimeout(timer)
        if (!result.ok) mobilePromptGrants.revoke(id)
        else if (result.queued) mobilePromptGrants.markQueued(id)
        resolve(result)
      })
      win.webContents.send('mobile:chat', delivery)
    })
  }
  submit = send
  win.once('closed', () => {
    if (submit === send) submit = null
    mobilePromptGrants.revokeSender(rendererSenderId)
    for (const settle of pending.values())
      settle({ ok: false, error: 'The desktop window closed.' })
  })
}
