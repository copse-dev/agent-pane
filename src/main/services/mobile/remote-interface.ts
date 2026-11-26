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
  type RemoteWatchedThread,
} from '../../../shared/remote-interface.ts'
import { broadcastToAppWindows } from '../../windows/app-window-broadcast.ts'

/**
 * How long one poll keeps a thread watched. Clients poll an open chat every
 * 1–2.5 s and stop while their page is hidden, so this outlasts a slow poll
 * and lets a closed chat's transcript leave the published view soon after.
 */
export const REMOTE_WATCH_TTL_MS = 15_000

/**
 * Each phone or shared-chat page polls one chat, so a few devices fit well
 * inside this. A client naming ever more threads cannot make the desktop
 * publish more transcripts than this. While the list is full of chats still
 * being polled, a newly polled chat stays on its saved view.
 */
const MAX_WATCHED = 8

/**
 * Twice the slowest poll interval. When the list is full, a thread not polled
 * for this long gives its place to a newly polled one.
 */
const REMOTE_WATCH_LEFT_MS = 5_000

/** Live renderer views are replicas; all prompt and queue writes still use mobile-chat. */
export class RemoteInterface {
  private views = new Map<string, RemoteView>()
  private revision = 0
  private sessionId = randomUUID()
  private deliver: ((id: string, request: RemoteRead) => void) | null = null
  private pending = new Map<string, (reply: RemoteReply) => void>()
  /** Snapshots already built at the current revision, by scope. */
  private snapshots = new Map<string, RemoteState>()
  /** Threads clients have polled, by `projectId\0threadId`, least recently polled first. */
  private watching = new Map<string, RemoteWatchedThread & { seenAt: number }>()
  private watchTimer: ReturnType<typeof setTimeout> | null = null
  private watchListeners = new Set<(watched: RemoteWatchedThread[]) => void>()

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
    // A client asking for one thread is showing it: keep its transcript published.
    if (scope?.threadId !== undefined) this.watch(scope.projectId, scope.threadId)
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

  /**
   * The threads clients are showing, which the desktop publishes in full.
   *
   * The desktop used to publish the transcript of every thread it had loaded,
   * and to send that whole project again on every streamed token. A project
   * with a few large transcripts open passed 1 GB per call, which aborts the
   * renderer while it serializes the call (#4445). A scoped poll never reads a
   * sibling's transcript, so only the polled threads need one.
   */
  watched(): RemoteWatchedThread[] {
    return [...this.watching.values()].map(({ projectId, threadId }) => ({ projectId, threadId }))
  }

  /** Called with the full list whenever a thread starts or stops being watched. */
  onWatchedChange(listener: (watched: RemoteWatchedThread[]) => void): () => void {
    this.watchListeners.add(listener)
    return () => {
      this.watchListeners.delete(listener)
    }
  }

  private watch(projectId: string, threadId: string): void {
    const key = `${projectId}\0${threadId}`
    const known = this.watching.get(key)
    if (known) {
      known.seenAt = Date.now()
      // Re-insert so the map stays least recently polled first.
      this.watching.delete(key)
      this.watching.set(key, known)
      return
    }
    // When full, make room only from threads whose polls have stopped. Evicting a
    // thread still being polled would, with one chat too many polling in turn,
    // always drop the next to poll, so no client would get its live view.
    if (this.watching.size >= MAX_WATCHED && !this.dropLapsed() && !this.dropLeft()) return
    this.watching.set(key, { projectId, threadId, seenAt: Date.now() })
    this.notifyWatched()
    this.scheduleWatchExpiry()
  }

  /**
   * Forgets the least recently polled thread if its client has most likely
   * moved on: a phone opening chat after chat leaves each one behind long
   * before the TTL runs out. True when it went.
   */
  private dropLeft(): boolean {
    const oldest = this.watching.entries().next().value
    if (!oldest || Date.now() - oldest[1].seenAt < REMOTE_WATCH_LEFT_MS) return false
    this.watching.delete(oldest[0])
    return true
  }

  /** Forgets threads no client has polled within the TTL; true when any went. */
  private dropLapsed(): boolean {
    const cutoff = Date.now() - REMOTE_WATCH_TTL_MS
    let changed = false
    for (const [key, entry] of this.watching) {
      if (entry.seenAt > cutoff) continue
      this.watching.delete(key)
      changed = true
    }
    return changed
  }

  private scheduleWatchExpiry(): void {
    if (this.watchTimer !== null) return
    const oldest = this.watching.values().next().value
    if (!oldest) return
    const delay = Math.max(0, oldest.seenAt + REMOTE_WATCH_TTL_MS - Date.now())
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null
      this.expireWatches()
    }, delay)
    // A watch must never keep the app (or a test run) alive on its own.
    this.watchTimer.unref()
  }

  private expireWatches(): void {
    if (this.dropLapsed()) this.notifyWatched()
    this.scheduleWatchExpiry()
  }

  private notifyWatched(): void {
    const watched = this.watched()
    for (const listener of this.watchListeners) listener(watched)
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
  // Every window that publishes needs the list, and a reloaded one asks for it.
  ipcMain.handle('remote:watched', (event) => {
    assertMainFrameSender(event, win)
    return remoteInterface.watched()
  })
  // For the app's lifetime: other main windows keep publishing after this one closes.
  remoteInterface.onWatchedChange((watched) => {
    broadcastToAppWindows('remote:watched-changed', watched)
  })
  win.once('closed', detach)
}
