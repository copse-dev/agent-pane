import { z } from 'zod'

/**
 * Frames for recording a Browser-pane tab.
 *
 * A `<webview>` guest paints in its own process, so the renderer has no canvas
 * to record. CDP `Page.startScreencast` hands over each painted frame as a JPEG
 * instead; the renderer draws those into a canvas and records that with the
 * same `MediaRecorder` path as the Desktop pane. No OS screen-recording
 * permission is involved, and only the tab's own pixels are captured.
 *
 * A screencast is paint-driven: a tab that is hidden or idle sends nothing, and
 * the recording simply holds the last frame.
 */

/** Longest edge sent. Frames become a ≤1280px still in `video_frames` anyway. */
const SCREENCAST_MAX_EDGE = 1600
const SCREENCAST_JPEG_QUALITY = 80

const zScreencastFrame = z.object({
  data: z.string(),
  sessionId: z.number(),
})

/** The slice of `WebContents.debugger` this needs, so tests can supply a fake. */
export interface RecordingDebugger {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): unknown
  on(event: 'detach', listener: (event: unknown, reason: string) => void): unknown
  removeListener(
    event: 'message',
    listener: (event: unknown, method: string, params: unknown) => void,
  ): unknown
  removeListener(event: 'detach', listener: (event: unknown, reason: string) => void): unknown
}

export interface RecordableContents {
  readonly id: number
  readonly debugger: RecordingDebugger
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}

export interface BrowserRecordingSink {
  frame(webContentsId: number, jpeg: Uint8Array): void
  /** The screencast stopped without being asked: the tab closed or a debugger took over. */
  ended(webContentsId: number, reason: string): void
}

interface ScreencastSession {
  contents: RecordableContents
  attachedHere: boolean
  release(): void
}

export class BrowserRecordingService {
  private readonly sessions = new Map<number, ScreencastSession>()
  private readonly sink: BrowserRecordingSink

  constructor(sink: BrowserRecordingSink) {
    this.sink = sink
  }

  isRecording(webContentsId: number): boolean {
    return this.sessions.has(webContentsId)
  }

  async start(contents: RecordableContents): Promise<void> {
    if (this.sessions.has(contents.id)) return
    const dbg = contents.debugger
    // Another client (DevTools protocol user) may already hold the debugger;
    // share it rather than fail, and leave it attached when we stop.
    const attachedHere = !dbg.isAttached()
    if (attachedHere) dbg.attach('1.3')

    const onMessage = (_event: unknown, method: string, params: unknown): void => {
      if (method !== 'Page.screencastFrame') return
      const frame = zScreencastFrame.safeParse(params)
      if (!frame.success) return
      // Unacknowledged frames throttle the stream, so ack before anything can throw.
      void dbg
        .sendCommand('Page.screencastFrameAck', { sessionId: frame.data.sessionId })
        .catch(() => {})
      this.sink.frame(contents.id, Buffer.from(frame.data.data, 'base64'))
    }
    const onDetach = (_event: unknown, reason: string): void => {
      this.end(contents.id, reason || 'detached')
    }
    const onDestroyed = (): void => {
      this.end(contents.id, 'tab closed')
    }
    dbg.on('message', onMessage)
    dbg.on('detach', onDetach)
    contents.once('destroyed', onDestroyed)

    const session: ScreencastSession = {
      contents,
      attachedHere,
      release: () => {
        dbg.removeListener('message', onMessage)
        dbg.removeListener('detach', onDetach)
        contents.removeListener('destroyed', onDestroyed)
      },
    }
    this.sessions.set(contents.id, session)
    try {
      await dbg.sendCommand('Page.startScreencast', {
        format: 'jpeg',
        quality: SCREENCAST_JPEG_QUALITY,
        maxWidth: SCREENCAST_MAX_EDGE,
        maxHeight: SCREENCAST_MAX_EDGE,
      })
    } catch (error) {
      this.stop(contents.id)
      throw error
    }
  }

  stop(webContentsId: number): void {
    const session = this.sessions.get(webContentsId)
    if (!session) return
    this.sessions.delete(webContentsId)
    session.release()
    const { contents } = session
    if (contents.isDestroyed() || !contents.debugger.isAttached()) return
    void contents.debugger.sendCommand('Page.stopScreencast').catch(() => {})
    if (session.attachedHere) {
      try {
        contents.debugger.detach()
      } catch {
        // Already detached by the tab going away; nothing left to release.
      }
    }
  }

  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id)
  }

  private end(webContentsId: number, reason: string): void {
    if (!this.sessions.has(webContentsId)) return
    this.stop(webContentsId)
    this.sink.ended(webContentsId, reason)
  }
}
