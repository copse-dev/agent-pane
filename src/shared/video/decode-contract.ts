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

/** Longest edge of a returned frame, before the caller's own `max_width`. */
export const DEFAULT_FRAME_MAX_WIDTH = 1280
export const MIN_FRAME_MAX_WIDTH = 320
export const MAX_FRAME_MAX_WIDTH = 1920

/**
 * WebP quality for returned frames. 0.7 keeps UI text and code legible at
 * 1280px while landing roughly 5-10x smaller than the equivalent PNG — the
 * "squashed but readable" point this feature trades on.
 */
export const DEFAULT_FRAME_QUALITY = 0.7

/** Default gap between samples. Fine enough to catch a click-through step. */
export const DEFAULT_SAMPLE_INTERVAL_SECONDS = 0.5

/**
 * Hard cap on how many positions are sampled in one call, whatever the window
 * length. Past this the interval stretches instead: every sample costs a seek,
 * a downscale and an encode, and bounds the decoder's peak memory.
 */
export const MAX_SAMPLES_PER_CALL = 600

export interface DecodeFramesRequest {
  requestId: string
  /** Raw file bytes. Turned into a blob URL in the decoder so canvas reads stay same-origin. */
  video: Uint8Array<ArrayBuffer>
  mimeType: string
  /** Window to sample, in seconds. `endSeconds` null means "to the end". */
  startSeconds: number
  endSeconds: number | null
  sampleIntervalSeconds: number
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
   * Encoded WebP data URL, or null when this sample is byte-identical at grid
   * resolution to the one before it. A still recording is almost all nulls, and
   * such a frame can never be selected, so encoding it would be pure waste.
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
