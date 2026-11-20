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
  type RemoteScope,
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
  /** Snapshots already built at the current revision, by scope. */
  private snapshots = new Map<string, RemoteState>()

  /**
   * The live views, or the part of them one client is showing.
   *
   * A phone polls this for a single open chat. Unscoped, every poll carried
   * every loaded transcript of every project the desktop had published. With a
   * project, only that project's view is returned; with a thread as well, its
   * sibling threads keep their metadata and lose their transcripts, in the same
   * `messagesLoaded: false` shape the desktop uses for a thread it has not opened.
   *
   * The same object is returned until something is published, so a caller may
   * key its own serialization on it.
   */
  snapshot(scope?: RemoteScope): RemoteState {
    const key = scope ? `${scope.projectId}\0${scope.threadId ?? ''}` : ''
    const cached = this.snapshots.get(key)
    if (cached) return cached
    const state: RemoteState = {
      version: REMOTE_INTERFACE_VERSION,
      sessionId: this.sessionId,
      revision: this.revision,
      views: scope ? this.scopedViews(scope) : [...this.views.values()],
    }
    // A handful of clients at most; an unbounded map would be a phone-controlled leak.
    if (this.snapshots.size >= 8) this.snapshots.clear()
    this.snapshots.set(key, state)
    return state
  }

  private scopedViews(scope: RemoteScope): RemoteView[] {
    const view = this.views.get(scope.projectId)
    if (!view) return []
    const { threadId } = scope
    if (threadId === undefined) return [view]
    return [
      {
        ...view,
        threads: view.threads.map((thread) =>
          thread.id === threadId || thread.messages.length === 0
            ? thread
            : { ...thread, messages: [], messagesLoaded: false },
        ),
      },
    ]
  }

  publish(view: RemoteView): void {
    this.views.set(view.projectId, view)
    this.revision++
    this.snapshots.clear()
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
    this.snapshots.clear()
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
