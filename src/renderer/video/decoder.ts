import {
  SIGNATURE_CHANNELS,
  frameDistance,
  sampleTimes,
  signatureGridFor,
  signatureLength,
  type SignatureGrid,
} from '@shared/video/frame-selection.ts'
import {
  FRAME_IMAGE_MIME,
  resolveSampleInterval,
  type DecodeFramesRequest,
  type DecodeFramesResponse,
  type DecodedFrame,
  type VideoDecoderBridge,
} from '@shared/video/decode-contract.ts'

declare global {
  interface Window {
    videoDecoder: VideoDecoderBridge
  }
}

/**
 * The offscreen half of `video_frames`: seek a video to a list of positions and
 * hand each one back as a downscaled JPEG plus a cell-colour signature.
 *
 * Seeking (rather than playing through and grabbing frames as they arrive) is
 * what makes a time range cheap — asking for 01:30–01:40 of an hour-long
 * recording decodes ten seconds' worth, not an hour's. It also makes the result
 * deterministic: the same request returns the same frames, which matters when
 * the model asks for a window it already looked at.
 */

/** A seek that never settles must not hang the tool; skip the sample instead. */
const SEEK_TIMEOUT_MS = 10_000
const METADATA_TIMEOUT_MS = 30_000

function waitForEvent(target: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      target.removeEventListener(event, onEvent)
      target.removeEventListener('error', onError)
      clearTimeout(timer)
    }
    const onEvent = (): void => {
      cleanup()
      resolve()
    }
    const onError = (): void => {
      cleanup()
      reject(new Error(target.error?.message ?? `video ${event} failed`))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for video ${event}`))
    }, timeoutMs)
    target.addEventListener(event, onEvent, { once: true })
    target.addEventListener('error', onError, { once: true })
  })
}

/**
 * A container written by a live recorder (MediaRecorder, some screen-capture
 * tools) often has no duration in its header and reports `Infinity`. Seeking
 * past the end forces Chromium to scan for the real end and correct it.
 */
async function resolveDuration(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration
  video.currentTime = Number.MAX_SAFE_INTEGER
  await waitForEvent(video, 'timeupdate', SEEK_TIMEOUT_MS).catch(() => undefined)
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration
  // Last resort: whatever position the scan landed on is at least a lower bound.
  return Number.isFinite(video.currentTime) ? video.currentTime : 0
}

async function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(video.currentTime - time) < 1e-3 && video.readyState >= 2) return
  const seeked = waitForEvent(video, 'seeked', SEEK_TIMEOUT_MS)
  video.currentTime = time
  await seeked
}

/** Target frame size: fit inside `maxWidth` without ever upscaling. */
function frameSize(video: HTMLVideoElement, maxWidth: number): { width: number; height: number } {
  const sourceWidth = video.videoWidth || maxWidth
  const sourceHeight = video.videoHeight || Math.round(maxWidth * 0.5625)
  const scale = Math.min(1, maxWidth / sourceWidth)
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  }
}

/**
 * Reduce a frame to one mean RGB triple per signature cell.
 *
 * The averaging is done by the GPU: drawing the frame into a
 * `grid.columns` x `grid.rows` canvas with smoothing on *is* a box filter, so a
 * 4K frame collapses to ~576 cells without a per-pixel loop in JS. Alpha is
 * dropped — a video frame is opaque.
 */
function signatureOf(
  source: CanvasImageSource,
  canvas: HTMLCanvasElement,
  grid: SignatureGrid,
): number[] {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('could not acquire a 2D context for frame signatures')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'low'
  ctx.drawImage(source, 0, 0, grid.columns, grid.rows)
  const { data } = ctx.getImageData(0, 0, grid.columns, grid.rows)
  const signature: number[] = new Array<number>(signatureLength(grid))
  for (let cell = 0; cell < grid.cells; cell++) {
    const pixel = cell * 4
    const base = cell * SIGNATURE_CHANNELS
    signature[base] = data[pixel] ?? 0
    signature[base + 1] = data[pixel + 1] ?? 0
    signature[base + 2] = data[pixel + 2] ?? 0
  }
  return signature
}

async function decodeFrames(request: DecodeFramesRequest): Promise<DecodeFramesResponse> {
  const blob = new Blob([request.video], { type: request.mimeType || 'video/mp4' })
  // A blob URL is same-origin, so drawing the video to a canvas leaves it
  // untainted and `toDataURL` works. A `file://` source would taint the canvas
  // and force `webSecurity: false` on this window — not worth it.
  const objectUrl = URL.createObjectURL(blob)
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.playsInline = true
  video.src = objectUrl

  try {
    await waitForEvent(video, 'loadedmetadata', METADATA_TIMEOUT_MS)
    const duration = await resolveDuration(video)
    if (!(duration > 0)) throw new Error('video reports no playable duration')

    const start = Math.max(0, Math.min(request.startSeconds, duration))
    const end = Math.max(start, Math.min(request.endSeconds ?? duration, duration))
    const { width, height } = frameSize(video, request.maxWidth)

    const frameCanvas = document.createElement('canvas')
    frameCanvas.width = width
    frameCanvas.height = height
    const frameCtx = frameCanvas.getContext('2d')
    if (!frameCtx) throw new Error('could not acquire a 2D context for frames')

    // Derived from the frame, not fixed: a portrait recording needs a tall grid
    // or every cell smears three times its own height (see signatureGridFor).
    const grid = signatureGridFor(width, height)
    const signatureCanvas = document.createElement('canvas')
    signatureCanvas.width = grid.columns
    signatureCanvas.height = grid.rows

    // Derived from the window unless the caller pinned one, so narrowing the
    // range genuinely buys temporal resolution rather than re-sampling the same
    // half-second grid.
    const sampleIntervalSeconds = resolveSampleInterval(end - start, request.sampleIntervalSeconds)
    const times = sampleTimes(start, end, sampleIntervalSeconds, request.maxSamples)
    const frames: DecodedFrame[] = []
    let previousSignature: number[] | null = null

    for (const time of times) {
      try {
        await seekTo(video, time)
      } catch {
        // A seek that fails or times out costs one sample, not the whole call.
        continue
      }
      frameCtx.drawImage(video, 0, 0, width, height)
      const signature = signatureOf(frameCanvas, signatureCanvas, grid)
      // Encoding is the expensive part, so skip it for a sample that is
      // identical to its predecessor at grid resolution — it could never be
      // chosen, and a still recording is almost entirely such samples.
      const unchanged =
        previousSignature !== null && frameDistance(previousSignature, signature) === 0
      frames.push({
        time,
        signature,
        dataUrl: unchanged ? null : frameCanvas.toDataURL(FRAME_IMAGE_MIME, request.quality),
      })
      previousSignature = signature
    }

    return {
      requestId: request.requestId,
      ok: true,
      durationSeconds: duration,
      sourceWidth: video.videoWidth,
      sourceHeight: video.videoHeight,
      frameWidth: width,
      frameHeight: height,
      sampleIntervalSeconds,
      frames,
    }
  } catch (err) {
    return {
      requestId: request.requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(objectUrl)
  }
}

window.videoDecoder.onRequest((request) => {
  void decodeFrames(request).then((response) => {
    window.videoDecoder.respond(response)
  })
})
window.videoDecoder.ready()
