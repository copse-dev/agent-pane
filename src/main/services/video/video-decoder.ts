import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { attachWebContentsLockdown } from '../../windows/web-contents-lockdown.ts'
import {
  VIDEO_DECODE_READY_CHANNEL,
  VIDEO_DECODE_REQUEST_CHANNEL,
  VIDEO_DECODE_RESULT_CHANNEL,
  type DecodeFramesRequest,
  type DecodeFramesResponse,
  type DecodeFramesResult,
} from '@shared/video/decode-contract.ts'

/**
 * Owns the hidden window that decodes video for `video_frames`.
 *
 * The window is created on first use and kept for a few minutes afterwards: a
 * model examining a recording usually asks for several ranges in a row, and
 * paying Chromium's window-startup cost once per range would dominate the tool's
 * latency. It is torn down when idle so an app that has finished with video
 * isn't holding a renderer (and a decoded video's worth of memory) open forever.
 */

/** How long an idle decoder window sticks around before being closed. */
const IDLE_SHUTDOWN_MS = 3 * 60_000

/**
 * Ceiling on a single decode. Long enough for a few hundred seeks over a large
 * file, short enough that a wedged decoder surfaces as a tool error rather than
 * an agent run that never finishes.
 */
const DECODE_TIMEOUT_MS = 5 * 60_000

interface PendingDecode {
  resolve: (result: DecodeFramesResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

let decoderWindow: BrowserWindow | null = null
let readyPromise: Promise<BrowserWindow> | null = null
let idleTimer: NodeJS.Timeout | null = null
let listenersAttached = false
const pending = new Map<string, PendingDecode>()
/** One video at a time: the page holds a single `<video>` and canvas pair. */
let queue: Promise<unknown> = Promise.resolve()

function settleAll(error: Error): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(error)
  }
  pending.clear()
}

function attachListeners(): void {
  if (listenersAttached) return
  listenersAttached = true
  ipcMain.on(VIDEO_DECODE_RESULT_CHANNEL, (event, response: DecodeFramesResponse) => {
    // Only the decoder window may answer; anything else is ignored outright.
    if (!decoderWindow || event.sender !== decoderWindow.webContents) return
    const entry = pending.get(response.requestId)
    if (!entry) return
    pending.delete(response.requestId)
    clearTimeout(entry.timer)
    if (response.ok) entry.resolve(response)
    else entry.reject(new Error(response.error))
  })
}

function scheduleIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (pending.size > 0) return
    closeVideoDecoder()
  }, IDLE_SHUTDOWN_MS)
  idleTimer.unref()
}

async function ensureDecoderWindow(): Promise<BrowserWindow> {
  if (decoderWindow && !decoderWindow.isDestroyed()) return decoderWindow
  if (readyPromise) return readyPromise

  attachListeners()
  readyPromise = new Promise<BrowserWindow>((resolve, reject) => {
    const win = new BrowserWindow({
      show: false,
      width: 640,
      height: 360,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // A hidden window is "occluded" as far as Chromium is concerned, which
        // throttles its timers — and every seek in the decoder is driven by an
        // event loop turn. Without this a decode crawls or stalls entirely.
        backgroundThrottling: false,
        preload: join(__dirname, '../preload/video-decoder.js'),
      },
    })
    attachWebContentsLockdown(win.webContents)

    const onReady = (event: Electron.IpcMainEvent): void => {
      if (event.sender !== win.webContents) return
      ipcMain.removeListener(VIDEO_DECODE_READY_CHANNEL, onReady)
      decoderWindow = win
      resolve(win)
    }
    ipcMain.on(VIDEO_DECODE_READY_CHANNEL, onReady)

    win.once('closed', () => {
      ipcMain.removeListener(VIDEO_DECODE_READY_CHANNEL, onReady)
      if (decoderWindow === win) decoderWindow = null
      readyPromise = null
      settleAll(new Error('The video decoder window closed before the decode finished.'))
    })

    win.webContents.once('render-process-gone', (_event, details) => {
      // A malformed or enormous video can take the renderer down. Report it as a
      // tool error rather than leaving the caller waiting for the timeout.
      settleAll(new Error(`The video decoder crashed (${details.reason}).`))
      if (!win.isDestroyed()) win.destroy()
    })

    win.loadFile(join(__dirname, '../renderer/video/decoder.html')).catch((err: unknown) => {
      readyPromise = null
      if (!win.isDestroyed()) win.destroy()
      reject(err instanceof Error ? err : new Error(String(err)))
    })
  })
  return readyPromise
}

export type DecodeFramesInput = Omit<DecodeFramesRequest, 'requestId'>

type DecodeFn = (input: DecodeFramesInput) => Promise<DecodeFramesResult>

let decodeOverride: DecodeFn | null = null

/** Test hook — decode without an Electron window. */
export function setVideoDecoderForTest(fn: DecodeFn | null): void {
  decodeOverride = fn
}

/**
 * Decode one video window into sampled frames. Calls are serialized, so a
 * second request waits for the first rather than fighting it for the single
 * `<video>` element.
 */
export function decodeVideoFrames(input: DecodeFramesInput): Promise<DecodeFramesResult> {
  if (decodeOverride) return decodeOverride(input)
  const run = queue.then(
    () => runDecode(input),
    () => runDecode(input),
  )
  // Keep the chain alive regardless of this call's outcome.
  queue = run.catch(() => undefined)
  return run
}

async function runDecode(input: DecodeFramesInput): Promise<DecodeFramesResult> {
  const win = await ensureDecoderWindow()
  const requestId = randomUUID()
  const result = await new Promise<DecodeFramesResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('Timed out decoding the video.'))
    }, DECODE_TIMEOUT_MS)
    timer.unref()
    pending.set(requestId, { resolve, reject, timer })
    win.webContents.send(VIDEO_DECODE_REQUEST_CHANNEL, { ...input, requestId })
  })
  scheduleIdleShutdown()
  return result
}

/** Tear the decoder window down (idle timeout, and app shutdown). */
export function closeVideoDecoder(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const win = decoderWindow
  decoderWindow = null
  readyPromise = null
  if (win && !win.isDestroyed()) win.destroy()
}
