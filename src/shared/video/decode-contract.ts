/**
 * The contract between the main process and the offscreen decoder window.
 *
 * Video decoding runs in a hidden renderer rather than in main because Chromium
 * already ships the codecs (H.264/HEVC in `.mov`/`.mp4`, VP8/VP9 in `.webm`) and
 * a `<canvas>` that can downscale and re-encode. That avoids bundling ffmpeg —
 * a per-platform binary, a licensing question, and another supply-chain
 * surface — for a feature whose whole point is to be cheap.
 */

/** IPC channels the decoder window and main exchange on. */
export const VIDEO_DECODE_REQUEST_CHANNEL = 'video-decoder:request'
export const VIDEO_DECODE_RESULT_CHANNEL = 'video-decoder:result'
export const VIDEO_DECODE_READY_CHANNEL = 'video-decoder:ready'

/**
 * Longest edge — width or height — of a returned frame, before the caller's own
 * `max_width`. Bounding the longest edge rather than the width is what keeps a
 * portrait recording from costing ~3x per frame: image token cost comes from the
 * pixel dimensions, and a 2296x3916 capture scaled to 1280 *wide* is 2183 tall.
 */
export const DEFAULT_FRAME_MAX_WIDTH = 1280
export const MIN_FRAME_MAX_WIDTH = 320
export const MAX_FRAME_MAX_WIDTH = 1920

/**
 * Encoding for returned frames.
 *
 * WebP is ~40% smaller than JPEG on a dense screen frame, and was the original
 * choice for that reason. It is the wrong trade: image *token* cost is computed
 * from the pixel dimensions, not the byte size, so WebP saves request bandwidth
 * and nothing else — while several OpenAI-compatible servers (LM Studio among
 * them) reject a `data:image/webp` payload outright with
 * `'url' field must be a base64 encoded image`, which fails the whole turn.
 * JPEG is accepted everywhere we send images and costs the same in context.
 */
export const FRAME_IMAGE_MIME = 'image/jpeg'

/** File extension matching {@link FRAME_IMAGE_MIME}, used in frame names. */
export const FRAME_IMAGE_EXTENSION = 'jpg'

/**
 * JPEG quality for returned frames. 0.8 rather than 0.7: JPEG rings around the
 * high-contrast edges of small UI text, and a frame the model cannot read is
 * worth nothing however small it is.
 */
export const DEFAULT_FRAME_QUALITY = 0.8

/**
 * How many positions a call aims to sample, whatever the window length.
 *
 * A *fixed* interval was the original design and it quietly broke the tool's
 * own advice. Sampling every 0.5s meant narrowing `start`/`end` bought no extra
 * detail — a 5-second window still got 11 samples — so anything shorter than
 * half a second (a flicker, a one-frame repaint, a spinner blinking) fell
 * between samples and was invisible no matter how far you zoomed in.
 *
 * Deriving the interval from the window instead makes narrowing mean something:
 * across a whole 57s recording this lands at ~480ms — the same resolution the
 * fixed grid gave, so a full survey is no coarser than before — while a 5s
 * window gets ~42ms and a 2.5s window ~33ms, one video frame. The seek count is
 * constant either way, so a close look costs no more than a survey.
 */
export const DEFAULT_TARGET_SAMPLES = 120

/** Finest sampling offered: ~one frame of a 30fps recording. */
export const MIN_SAMPLE_INTERVAL_SECONDS = 1 / 30

/** Coarsest derived sampling, so a long recording still gets a usable scan. */
export const MAX_SAMPLE_INTERVAL_SECONDS = 2

/**
 * Hard cap on how many positions are sampled in one call. Only bites when a
 * caller asks for an interval fine enough to exceed it over a long window; every
 * sample costs a seek, a downscale and an encode.
 */
export const MAX_SAMPLES_PER_CALL = 600

/**
 * Gap between samples for a window of `spanSeconds`, honouring an explicit
 * request and otherwise aiming at {@link DEFAULT_TARGET_SAMPLES}.
 */
export function resolveSampleInterval(spanSeconds: number, requested?: number | null): number {
  const clamp = (v: number): number =>
    Math.min(MAX_SAMPLE_INTERVAL_SECONDS, Math.max(MIN_SAMPLE_INTERVAL_SECONDS, v))
  if (requested !== undefined && requested !== null && requested > 0) return clamp(requested)
  if (!(spanSeconds > 0)) return MIN_SAMPLE_INTERVAL_SECONDS
  return clamp(spanSeconds / Math.max(1, DEFAULT_TARGET_SAMPLES - 1))
}

/**
 * Fit a frame inside `maxEdge` on its longest side, never upscaling.
 *
 * Scaling on width alone is the obvious reading of an argument called
 * `max_width`, and it is wrong for anything taller than it is wide: a 2296x3916
 * portrait capture came back at 1280x2183 — 2.8M pixels against the 0.96M a
 * landscape frame gets from the same budget. Image token cost is computed from
 * the pixel dimensions, so a portrait recording silently cost ~3x per frame.
 */
export function frameSizeFor(
  sourceWidth: number,
  sourceHeight: number,
  maxEdge: number,
): { width: number; height: number } {
  const width = sourceWidth > 0 ? sourceWidth : maxEdge
  const height = sourceHeight > 0 ? sourceHeight : Math.round(maxEdge * 0.5625)
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export interface DecodeFramesRequest {
  requestId: string
  /** Raw file bytes. Turned into a blob URL in the decoder so canvas reads stay same-origin. */
  video: Uint8Array<ArrayBuffer>
  mimeType: string
  /** Window to sample, in seconds. `endSeconds` null means "to the end". */
  startSeconds: number
  endSeconds: number | null
  /** Explicit gap between samples; null derives one from the window length. */
  sampleIntervalSeconds: number | null
  maxSamples: number
  maxWidth: number
  quality: number
}

export interface DecodedFrame {
  /** Position in the source video, in seconds. */
  time: number
  /** Cell-mean RGB grid for the distance function; see `frame-selection.ts`. */
  signature: number[]
  /**
   * Encoded image data URL ({@link FRAME_IMAGE_MIME}), or null when this sample
   * is byte-identical at grid resolution to the one before it. A still recording
   * is almost all nulls, and such a frame can never be selected, so encoding it
   * would be pure waste.
   */
  dataUrl: string | null
}

export interface DecodeFramesResult {
  requestId: string
  ok: true
  durationSeconds: number
  /** Native video dimensions, before downscaling. */
  sourceWidth: number
  sourceHeight: number
  /** Dimensions of the returned frames. */
  frameWidth: number
  frameHeight: number
  /**
   * The gap actually used between samples. Reported back so the caller can tell
   * the model what temporal resolution it is looking at — an event shorter than
   * this can fall between samples and never appear.
   */
  sampleIntervalSeconds: number
  frames: DecodedFrame[]
}

export interface DecodeFramesFailure {
  requestId: string
  ok: false
  error: string
}

export type DecodeFramesResponse = DecodeFramesResult | DecodeFramesFailure

/**
 * The bridge the decoder window's preload exposes as `window.videoDecoder`.
 * Declared here rather than in the preload so the renderer-side decoder can
 * reference the type without pulling `electron` into the web type program.
 */
export interface VideoDecoderBridge {
  onRequest(handler: (request: DecodeFramesRequest) => void): void
  respond(response: DecodeFramesResponse): void
  ready(): void
}
