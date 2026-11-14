import type { BrowserWindow, IpcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs, zThreadId } from '../../ipc/ipc-guards.ts'
import type {
  MobileChatCommand,
  MobileChatRequest,
  MobileChatResult,
  MobilePlanReview,
} from '../../../shared/mobile-chat.ts'
import type { StoredThreadPlan } from '@copse/thread-store/plan-schema.ts'
import {
  createThreadWithResult,
  getLatestThreadPlan,
  getProjectThread,
  loadAgentHistory,
} from '../thread-store.ts'
import { getSettingsSnapshot } from '../storage/settings-transaction.ts'
import { mobilePromptGrants } from './mobile-prompt-grants.ts'
import { mobilePlanAuthorityHash } from './mobile-plan-review.ts'

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

export function admitReviewedMobilePlan(
  plan: StoredThreadPlan | null,
  reviewed: MobilePlanReview | undefined,
): { ok: true; plan: StoredThreadPlan | null } | { ok: false } {
  const active = plan?.meta.status === 'abandoned' ? null : plan
  if (active === null) return reviewed === undefined ? { ok: true, plan: null } : { ok: false }
  return reviewed !== undefined &&
    reviewed.planId === active.meta.planId &&
    reviewed.revision === active.meta.currentRevision &&
    reviewed.contentHash === active.contentHash &&
    reviewed.authorityHash === mobilePlanAuthorityHash(active)
    ? { ok: true, plan: structuredClone(active) }
    : { ok: false }
}

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
    const planAdmission = admitReviewedMobilePlan(plan, command.planReview)
    if (!planAdmission.ok)
      return {
        ok: false,
        error: 'The thread plan changed. Refresh it on your phone and review it before sending.',
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
        createsThread: createThread,
        plan: planAdmission.plan,
        ...(model !== undefined ? { model } : {}),
        expiresAt,
      },
      stillAuthorized,
    )
    if (createThread) {
      const now = Date.now()
      try {
        const created = await createThreadWithResult(command.projectId, {
          id: threadId,
          title: 'New Thread',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          ...(model !== undefined ? { model } : {}),
          createdAt: now,
          updatedAt: now,
        })
        if (!created) throw new Error('Mobile prompt target storage already exists')
      } catch {
        mobilePromptGrants.revoke(id)
        return {
          ok: false,
          error: 'The desktop could not reserve a fresh conversation. Try sending again.',
        }
      }
      if (!stillAuthorized()) {
        mobilePromptGrants.revoke(id)
        return { ok: false, error: 'Phone control was disabled before the message was admitted.' }
      }
    }
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
