import { FRAME_IMAGE_EXTENSION } from './decode-contract.ts'

/**
 * Video attachment vocabulary shared by the renderer (composer drops), the main
 * process (blob storage, the `video_frames` tool) and the offscreen decoder.
 *
 * A video never enters the model's context as media. Screen recordings are the
 * motivating case: a two-minute capture is tens of megabytes of mostly-identical
 * frames, and even one frame per second would blow a context window for no gain.
 * Instead the file is stored next to the thread and the model pulls the handful
 * of *visually distinct* stills it actually needs through `video_frames`.
 */

/** Extensions Chromium can decode in the offscreen decoder on every platform we ship. */
export const SUPPORTED_VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ogv'] as const

/**
 * Cap on a stored video. The decoder hands the whole file to a hidden renderer
 * as one buffer, so this bounds peak memory (a few times the file size across
 * main and the renderer) rather than any codec limit. 256 MB is well past a
 * typical H.264 screen capture; a recording bigger than that should be trimmed,
 * and the tool says so rather than failing opaquely.
 */
export const MAX_VIDEO_BYTES = 256 * 1024 * 1024

export interface VideoAttachmentRef {
  /** Absolute path of the stored copy, inside the thread's blobs directory. */
  path: string
  /** Original file name, shown on the composer chip and in the prompt note. */
  name: string
  sizeBytes: number
  mimeType: string
}

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

/**
 * Whether a dropped/picked file should be treated as a video attachment.
 *
 * The MIME type is checked first because a browser `File` reports it reliably,
 * but macOS screen recordings occasionally arrive with an empty `type`, so the
 * extension is a fallback rather than a second opinion.
 */
export function isVideoFile(file: { name: string; type?: string }): boolean {
  if (file.type?.startsWith('video/')) return true
  return (SUPPORTED_VIDEO_EXTENSIONS as readonly string[]).includes(fileExtension(file.name))
}

/** `1.4 MB` — used on the composer chip and in the model-facing note. */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value).toString()} ${units[unit] ?? 'GB'}`
}

/**
 * A timestamp scaled to the recording it came from: `3.386s` for a clip under a
 * minute, `01:23.450` under an hour, `00:01:23.450` beyond.
 *
 * Hours and minutes a recording can never reach are pure noise, and the frame
 * manifest repeats this on every line — `frame-00-00-03.386.jpg` spends four
 * tokens saying "not hours, not minutes" about a 57-second video. Omitting the
 * components the duration rules out is the same information for roughly half
 * the tokens. Every form here round-trips through {@link parseTimePosition}, so
 * a model can hand any of them straight back as `start`/`end`.
 */
export function formatTimestamp(
  seconds: number,
  durationSeconds = Number.POSITIVE_INFINITY,
): string {
  const clamped = Math.max(0, seconds)
  const totalMs = Math.round(clamped * 1000)
  const ms = totalMs % 1000
  const totalSeconds = (totalMs - ms) / 1000
  const s = totalSeconds % 60
  const totalMinutes = (totalSeconds - s) / 60
  const m = totalMinutes % 60
  const h = (totalMinutes - m) / 60
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  // Never shorten below what the timestamp itself needs, whatever it was told
  // the duration was.
  const scale = Math.max(clamped, durationSeconds)
  if (scale < 60) return `${String(s)}.${pad(ms, 3)}s`
  if (scale < 3600) return `${pad(m)}:${pad(s)}.${pad(ms, 3)}`
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`
}

/**
 * `frame-3.386s.jpg` / `frame-00-01-23.450.jpg` — the timestamp with `:` swapped
 * for `-`, since a colon is not a legal filename character on Windows and
 * confuses shells elsewhere. Pass the recording's duration to drop the leading
 * components it can never reach. The extension defaults to the encoder's, so a
 * name can never claim a format the bytes are not.
 */
export function frameFileName(
  seconds: number,
  extension = FRAME_IMAGE_EXTENSION,
  durationSeconds = Number.POSITIVE_INFINITY,
): string {
  return `frame-${formatTimestamp(seconds, durationSeconds).replace(/:/g, '-')}.${extension}`
}

/**
 * Parse a user- or model-supplied time position. Accepts plain seconds (`12`,
 * `12.5`, `12.5s`), `mm:ss`, and `hh:mm:ss`, each with optional fractional
 * seconds. Returns null for anything else so callers can report the bad input
 * rather than silently seeking to 0.
 *
 * The trailing `s` matters: it is the form {@link formatTimestamp} emits for a
 * short recording, and the form a model reaches for unprompted ("look at 3.4s").
 */
export function parseTimePosition(value: string | number): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const plainSeconds = /^(\d+(?:\.\d+)?)s?$/.exec(trimmed)
  if (plainSeconds?.[1]) return Number(plainSeconds[1])
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(trimmed)
  if (!match) return null
  const [, hours, minutes, secs] = match
  const m = Number(minutes)
  const s = Number(secs)
  if (m > 59 || s >= 60) return null
  return Number(hours ?? 0) * 3600 + m * 60 + s
}
