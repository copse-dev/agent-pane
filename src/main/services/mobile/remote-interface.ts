import type { BrowserWindow, IpcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs } from '../../ipc/ipc-guards.ts'
import {
  REMOTE_INTERFACE_VERSION,
  remoteReadAllowed,
  remoteThreadSchema,
  remoteReplySchema,
  remoteViewSchema,
  type RemoteRead,
  type RemoteReply,
  type RemoteState,
  type RemoteView,
} from '../../../shared/remote-interface.ts'

/** Live renderer views are replicas; all prompt and queue writes still use mobile-chat. */
export class RemoteInterface {
  private views = new Map<string, RemoteView>()
  private revision = 0
  private sessionId = randomUUID()
  private deliver: ((id: string, request: RemoteRead) => void) | null = null
  private pending = new Map<string, (reply: RemoteReply) => void>()

  snapshot(): RemoteState {
    return {
      version: REMOTE_INTERFACE_VERSION,
      sessionId: this.sessionId,
      revision: this.revision,
      views: [...this.views.values()],
    }
  }

  publish(view: RemoteView): void {
    this.views.set(view.projectId, view)
    this.revision++
  }

  attach(deliver: (id: string, request: RemoteRead) => void): () => void {
    this.close()
    this.deliver = deliver
    return () => {
      if (this.deliver === deliver) this.close()
    }
  }

  close(): void {
    this.deliver = null
    this.views.clear()
    this.sessionId = randomUUID()
    this.revision++
    for (const [id, settle] of this.pending)
      settle({ id, ok: false, error: 'The desktop window closed. Reopen Copse to continue.' })
  }

  reply(reply: RemoteReply): void {
    this.pending.get(reply.id)?.(reply)
  }

  async read(request: RemoteRead, authorized: () => boolean): Promise<unknown> {
    if (!authorized()) throw new Error('Remote control was revoked.')
    if (!remoteReadAllowed(request)) throw new Error('This setting is available only on the Mac.')
    const deliver = this.deliver
    if (!deliver) throw new Error('Open the Copse desktop window to use the remote interface.')
    if (this.pending.size >= 16) throw new Error('The desktop is busy. Try again shortly.')
    const id = randomUUID()
    const value = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('The desktop request timed out.'))
      }, 30_000)
      this.pending.set(id, (reply) => {
        clearTimeout(timer)
        this.pending.delete(id)
        if (!authorized()) reject(new Error('Remote control was revoked.'))
        else if (reply.ok) resolve(reply.value)
        else reject(new Error(reply.error))
      })
      try {
        deliver(id, request)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error('Desktop unavailable.'))
      }
    })
    if (!authorized()) throw new Error('Remote control was revoked.')
    if (request.channel === 'threads:load-project') return z.array(remoteThreadSchema).parse(value)
    return value
  }
}

export const remoteInterface = new RemoteInterface()

export function initRemoteInterface(win: BrowserWindow, ipcMain: IpcMain): void {
  const detach = remoteInterface.attach((id, request) => {
    if (win.isDestroyed()) throw new Error('Desktop unavailable.')
    win.webContents.send('remote:read', id, request)
  })
  ipcMain.handle('remote:publish', (event, ...args) => {
    assertMainFrameSender(event, win)
    const view = parseIpcArgs(remoteViewSchema, args)
    remoteInterface.publish(view)
  })
  ipcMain.handle('remote:reply', (event, ...args) => {
    assertMainFrameSender(event, win)
    const reply = parseIpcArgs(remoteReplySchema, args)
    remoteInterface.reply(reply)
  })
  win.once('closed', detach)
}
