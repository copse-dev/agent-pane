import { MAX_VIDEO_BYTES } from '@shared/video/video-media.ts'
import { drawFitted, evenFrameSize } from './canvas-fit.ts'

/**
 * Record a `<canvas>` to WebM with Chromium's own encoder.
 *
 * Every surface Copse can record already paints into a canvas the renderer
 * owns: noVNC draws the remote framebuffer into one, the Simulator/emulator
 * view draws device frames into one, and a browser-tab recording draws its
 * screencast frames into one. So recording is `captureStream()` +
 * `MediaRecorder` — no OS screen-recording permission, no bundled encoder,
 * and only the pixels of that one surface, never the rest of the screen.
 *
 * The output is an ordinary `.webm` that `video_frames` already decodes.
 */

/** Hard stop. Long enough to reproduce a bug, short enough to stay well under the cap. */
export const RECORDING_MAX_DURATION_MS = 5 * 60_000

/** Stop before the chat attachment cap, leaving room for the final chunk. */
export const RECORDING_MAX_BYTES = MAX_VIDEO_BYTES - 16 * 1024 * 1024

/** ~94 MB over the full five minutes — under the cap even when every frame changes. */
const RECORDING_BITS_PER_SECOND = 2_500_000

/** Chunks are flushed this often, so the size budget is checked as the file grows. */
const RECORDING_CHUNK_MS = 1_000

/**
 * How often the source is copied into the recorded canvas. A canvas stream
 * only emits a frame when its canvas is drawn, and a still surface — an idle
 * remote desktop — draws nothing, so recording the source directly can yield
 * no frames at all. Copying on a fixed clock keeps the timeline populated (a
 * seek into a quiet stretch lands on a nearby frame), and VP9 encodes an
 * unchanged frame in a few bytes.
 */
const RECORDING_FRAME_MS = 100

const RECORDING_MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const

export type RecordingStopReason = 'user' | 'duration-limit' | 'size-limit' | 'source-ended'

export interface RecordingResult {
  blob: Blob
  durationMs: number
  reason: RecordingStopReason
}

export interface CanvasRecording {
  elapsedMs(): number
  recordedBytes(): number
  /** Stop and finalise. Idempotent: later calls return the first stop's result. */
  stop(reason?: RecordingStopReason): Promise<RecordingResult>
  /** Settles once, whichever stop came first — the user, a limit, or the source ending. */
  readonly finished: Promise<RecordingResult>
}

/** The first WebM flavour this Chromium can encode, preferring the smaller VP9. */
export function pickRecordingMimeType(isTypeSupported: (type: string) => boolean): string | null {
  return RECORDING_MIME_CANDIDATES.find((type) => isTypeSupported(type)) ?? null
}

/** Which budget, if any, a recording of this length and size has run out of. */
export function recordingLimitReached(
  elapsedMs: number,
  bytes: number,
): Extract<RecordingStopReason, 'duration-limit' | 'size-limit'> | null {
  if (bytes >= RECORDING_MAX_BYTES) return 'size-limit'
  if (elapsedMs >= RECORDING_MAX_DURATION_MS) return 'duration-limit'
  return null
}

export function startCanvasRecording(source: HTMLCanvasElement): CanvasRecording {
  const mimeType = pickRecordingMimeType((type) => MediaRecorder.isTypeSupported(type))
  if (!mimeType) throw new Error('This build cannot encode WebM video.')
  // The recorded frame keeps the source's starting size for the whole take.
  const frame = evenFrameSize(source.width, source.height)
  const canvas = document.createElement('canvas')
  canvas.width = frame.width
  canvas.height = frame.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not create a canvas to record into.')
  const paint = (): void => {
    if (source.width > 0 && source.height > 0) {
      drawFitted(context, source, frame.width, frame.height)
    }
  }
  paint()
  const stream = canvas.captureStream()
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: RECORDING_BITS_PER_SECOND,
  })
  const chunks: Blob[] = []
  const startedAt = performance.now()
  let bytes = 0
  let endedAt: number | null = null
  let stopReason: RecordingStopReason | null = null

  const finished = new Promise<RecordingResult>((resolve, reject) => {
    recorder.addEventListener('stop', () => {
      for (const t of stream.getTracks()) t.stop()
      resolve({
        blob: new Blob(chunks, { type: 'video/webm' }),
        durationMs: (endedAt ?? performance.now()) - startedAt,
        reason: stopReason ?? 'source-ended',
      })
    })
    recorder.addEventListener('error', (event) => {
      for (const t of stream.getTracks()) t.stop()
      window.clearInterval(ticker)
      const cause: unknown = event instanceof ErrorEvent ? event.error : null
      reject(cause instanceof Error ? cause : new Error('The recorder failed.'))
    })
  })

  const elapsedMs = (): number => (endedAt ?? performance.now()) - startedAt

  function stop(reason: RecordingStopReason = 'user'): Promise<RecordingResult> {
    if (stopReason !== null) return finished
    stopReason = reason
    endedAt = performance.now()
    window.clearInterval(ticker)
    if (recorder.state !== 'inactive') recorder.stop()
    return finished
  }

  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size === 0) return
    chunks.push(event.data)
    bytes += event.data.size
    const limit = recordingLimitReached(elapsedMs(), bytes)
    if (limit) void stop(limit)
  })

  const ticker = window.setInterval(() => {
    const limit = recordingLimitReached(elapsedMs(), bytes)
    if (limit) {
      void stop(limit)
      return
    }
    paint()
  }, RECORDING_FRAME_MS)

  recorder.start(RECORDING_CHUNK_MS)
  return { elapsedMs, recordedBytes: () => bytes, stop, finished }
}
