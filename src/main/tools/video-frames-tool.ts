import { z } from 'zod'
import { defineTool, type ToolResultImage } from '@shared/types'
import {
  MAX_VIDEO_BYTES,
  SUPPORTED_VIDEO_EXTENSIONS,
  fileExtension,
  formatByteSize,
  formatTimestamp,
  frameFileName,
  parseTimePosition,
} from '@shared/video/video-media.ts'
import {
  peakChange,
  selectDistinctFrames,
  type FrameCandidate,
} from '@shared/video/frame-selection.ts'
import {
  DEFAULT_FRAME_MAX_WIDTH,
  FRAME_IMAGE_EXTENSION,
  MAX_SAMPLE_INTERVAL_SECONDS,
  MIN_SAMPLE_INTERVAL_SECONDS,
  DEFAULT_FRAME_QUALITY,
  MAX_FRAME_MAX_WIDTH,
  MAX_SAMPLES_PER_CALL,
  MIN_FRAME_MAX_WIDTH,
} from '@shared/video/decode-contract.ts'
import { resolveReadablePathWithinRoot } from '../services/workspace.ts'
import { requireAgentExecutionRoot } from '../services/execution-root.ts'
import { getActiveWorkspaceFs } from '../services/workspace-fs/get-workspace-fs.ts'
import { decodeVideoFrames } from '../services/video/video-decoder.ts'

/**
 * Read a video as a handful of stills instead of as a video.
 *
 * A screen recording is an extremely redundant document: thirty frames a second
 * of a screen that changes a few times a minute. No model can watch it, and
 * naively sampling it would spend a context window on near-duplicates. This tool
 * samples the requested window, measures how much of the screen actually
 * repainted between samples (`frame-selection.ts`), and returns only the frames
 * that carry new information — one frame for a recording that never changes.
 *
 * The audio track is simply never decoded.
 */

/**
 * Frames returned when the model doesn't ask for a number.
 *
 * Ten images is already a substantial slice of a context window, and it is
 * enough to survey almost any recording: the frames kept are the biggest
 * changes, so what survives the cap is the shape of what happened. The result
 * says when it capped, and narrowing `start`/`end` is the cheaper way to see
 * more of one moment than raising this is to see more of everything.
 */
const DEFAULT_MAX_FRAMES = 10

/** Ceiling on `max_frames`, for the rare case a model deliberately wants more. */
const MAX_MAX_FRAMES = 60

/** Cap on total returned image bytes, so one call can't swamp a context window. */
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024

function describeSupportedFormats(): string {
  return SUPPORTED_VIDEO_EXTENSIONS.join(', ')
}

/** `85ms` / `1.2s` — short enough to sit inline in the manifest header. */
function formatInterval(seconds: number): string {
  return seconds < 1 ? `${String(Math.round(seconds * 1000))}ms` : `${seconds.toFixed(1)}s`
}

/**
 * `34%` / `0.4%` — a change small enough to fall under the bar still has to read
 * as a number, and rounding 0.4% to "0%" would say the opposite of what happened.
 */
function formatChange(fraction: number): string {
  const percent = fraction * 100
  return percent > 0 && percent < 1 ? `${percent.toFixed(1)}%` : `${String(Math.round(percent))}%`
}

function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return dataUrl.length
  // base64 encodes 3 bytes per 4 characters.
  return Math.floor(((dataUrl.length - comma - 1) * 3) / 4)
}

interface ResolvedWindow {
  start: number
  end: number | null
  error?: undefined
}

function resolveWindow(
  start: string | undefined,
  end: string | undefined,
): ResolvedWindow | { error: string } {
  const startSeconds = start === undefined ? 0 : parseTimePosition(start)
  if (startSeconds === null) {
    return {
      error: `Could not read start time ${JSON.stringify(start)}. Use seconds (12.5) or mm:ss / hh:mm:ss.`,
    }
  }
  const endSeconds = end === undefined ? null : parseTimePosition(end)
  if (end !== undefined && endSeconds === null) {
    return {
      error: `Could not read end time ${JSON.stringify(end)}. Use seconds (12.5) or mm:ss / hh:mm:ss.`,
    }
  }
  if (endSeconds !== null && endSeconds <= startSeconds) {
    return {
      error: `end (${formatTimestamp(endSeconds)}) must be after start (${formatTimestamp(startSeconds)}).`,
    }
  }
  return { start: startSeconds, end: endSeconds }
}

export const videoFramesTool = defineTool({
  name: 'video_frames',
  description:
    'Read a video (typically a screen recording) as a small set of still images. Samples the video and returns only the frames that are visually distinct from each other, so a recording of a mostly-static screen costs a few images rather than hundreds — a still video returns exactly one. Audio is ignored. With no `start`/`end` it covers the whole video; pass a range to look closely at one moment. Each image is named for its timestamp (`frame-00-01-23.450.jpg` = 00:01:23.450), so you can quote a time back to the user or re-request that moment with a tighter range. Raise `sensitivity` to catch smaller changes, lower it for fewer frames.',
  parameters: z.object({
    path: z
      .string()
      .describe(
        `Path to the video: workspace-relative, or the absolute path given for a video the user attached to the chat. Supported: ${describeSupportedFormats()}.`,
      ),
    start: z
      .string()
      .optional()
      .describe(
        'Start of the window to read, as seconds ("12.5") or "mm:ss" / "hh:mm:ss". Defaults to the start of the video.',
      ),
    end: z
      .string()
      .optional()
      .describe('End of the window, same formats as start. Defaults to the end of the video.'),
    max_frames: z
      .number()
      .int()
      .min(1)
      .max(MAX_MAX_FRAMES)
      .optional()
      .describe(
        `Most frames to return (default ${String(DEFAULT_MAX_FRAMES)}, max ${String(MAX_MAX_FRAMES)}). When more distinct frames exist, the ones showing the biggest changes are kept.`,
      ),
    sensitivity: z
      .enum(['low', 'normal', 'high'])
      .optional()
      .describe(
        'How much of the screen must change for a frame to count as new. "high" catches small edits (a changed line of text), "low" returns only major transitions. Default "normal".',
      ),
    interval: z
      .number()
      .min(MIN_SAMPLE_INTERVAL_SECONDS)
      .max(MAX_SAMPLE_INTERVAL_SECONDS)
      .optional()
      .describe(
        'Seconds between samples. Omit to derive one from the window — narrowing start/end already samples more finely. Set it only to go finer still (minimum ~0.033s, one video frame) when hunting something very short-lived.',
      ),
    max_width: z
      .number()
      .int()
      .min(MIN_FRAME_MAX_WIDTH)
      .max(MAX_FRAME_MAX_WIDTH)
      .optional()
      .describe(
        `Longest edge of the returned frames in pixels (default ${String(DEFAULT_FRAME_MAX_WIDTH)}). Lower it to save context, raise it only when small text is unreadable.`,
      ),
  }),
  async execute({ path, start, end, max_frames, sensitivity, max_width, interval }, signal) {
    // Read through a function: decoding is the slow step and the run can be
    // cancelled during it, but a direct `signal.aborted` check reads as
    // permanently false to the type-narrowing after the first one.
    const cancelled = (): boolean => signal.aborted

    const window = resolveWindow(start, end)
    if (window.error !== undefined) return window.error

    const extension = fileExtension(path)
    if (!(SUPPORTED_VIDEO_EXTENSIONS as readonly string[]).includes(extension)) {
      return `${path} is not a supported video (${describeSupportedFormats()}).`
    }

    const root = requireAgentExecutionRoot()
    let absPath: string
    try {
      absPath = await resolveReadablePathWithinRoot(path, root)
    } catch (err) {
      return err instanceof Error ? err.message : `Could not resolve ${path}.`
    }

    let bytes: Buffer
    try {
      bytes = await getActiveWorkspaceFs().readFileBytes(absPath)
    } catch {
      return `Could not read video: ${path}`
    }
    if (bytes.byteLength === 0) return `${path} is empty.`
    if (bytes.byteLength > MAX_VIDEO_BYTES) {
      return `${path} is ${formatByteSize(bytes.byteLength)}, over the ${formatByteSize(MAX_VIDEO_BYTES)} limit for frame extraction. Trim the recording and try again.`
    }
    if (cancelled()) return 'Cancelled before decoding the video.'

    const maxFrames = max_frames ?? DEFAULT_MAX_FRAMES
    const maxWidth = max_width ?? DEFAULT_FRAME_MAX_WIDTH

    let decoded
    try {
      decoded = await decodeVideoFrames({
        // Copied out of the Buffer so the payload is plainly ArrayBuffer-backed
        // for structured clone; `bytes` is unreferenced from here on.
        video: new Uint8Array(bytes),
        mimeType: mimeTypeForExtension(extension),
        startSeconds: window.start,
        endSeconds: window.end,
        sampleIntervalSeconds: interval ?? null,
        maxSamples: MAX_SAMPLES_PER_CALL,
        maxWidth,
        quality: DEFAULT_FRAME_QUALITY,
      })
    } catch (err) {
      return `Could not decode ${path}: ${err instanceof Error ? err.message : String(err)}`
    }
    if (cancelled()) return 'Cancelled after decoding the video.'

    if (decoded.frames.length === 0) {
      return `No frames could be read from ${path} between ${formatTimestamp(window.start)} and ${formatTimestamp(window.end ?? decoded.durationSeconds)}.`
    }

    const candidates: FrameCandidate[] = decoded.frames.map((f) => ({
      time: f.time,
      signature: f.signature,
    }))
    const selected = selectDistinctFrames(candidates, {
      sensitivity: sensitivity ?? 'normal',
      maxFrames,
    })

    // A sample the decoder skipped encoding was identical to its predecessor, so
    // it can only be selected as the very first frame; fall back to the nearest
    // encoded frame in that case rather than returning a hole.
    const encodedByTime = new Map<number, string>()
    let lastEncoded: string | null = null
    for (const frame of decoded.frames) {
      if (frame.dataUrl) lastEncoded = frame.dataUrl
      if (lastEncoded) encodedByTime.set(frame.time, lastEncoded)
    }

    const images: ToolResultImage[] = []
    const lines: string[] = []
    let totalBytes = 0
    let droppedForSize = 0
    for (const frame of selected) {
      const dataUrl = encodedByTime.get(frame.time)
      if (!dataUrl) continue
      const name = frameFileName(frame.time, FRAME_IMAGE_EXTENSION)
      const size = dataUrlBytes(dataUrl)
      if (totalBytes + size > MAX_TOTAL_IMAGE_BYTES && images.length > 0) {
        droppedForSize += 1
        continue
      }
      totalBytes += size
      images.push({ dataUrl, name })
      lines.push(
        images.length === 1
          ? `  ${name}  ${formatTimestamp(frame.time)}`
          : `  ${name}  ${formatTimestamp(frame.time)}  (${formatChange(frame.change)} of the frame changed)`,
      )
    }

    if (images.length === 0) {
      return `No frames could be encoded from ${path}. The file may be corrupt or use a codec this platform cannot decode.`
    }

    const windowEnd = window.end ?? decoded.durationSeconds
    const header = [
      `${path} — ${String(decoded.sourceWidth)}x${String(decoded.sourceHeight)}, ${formatTimestamp(decoded.durationSeconds)} long.`,
      `Sampled ${formatTimestamp(window.start)}–${formatTimestamp(Math.min(windowEnd, decoded.durationSeconds))} every ${formatInterval(decoded.sampleIntervalSeconds)} (${String(decoded.frames.length)} samples); ${String(images.length)} visually distinct frame${images.length === 1 ? '' : 's'} returned at ${String(decoded.frameWidth)}x${String(decoded.frameHeight)}.`,
      // The blind spot is the single most useful thing to say here: without it a
      // model reads "nothing changed" as "nothing happened", when a flicker
      // shorter than the sampling gap simply landed between two samples.
      `Anything lasting less than ${formatInterval(decoded.sampleIntervalSeconds)} can fall between samples and not appear at all. To look for something brief, narrow start/end (which samples more finely) or set \`interval\`.`,
    ]
    if (images.length === 1) {
      // "1 frame" on its own is ambiguous in the way that matters: it reads as
      // "nothing happened" when it can equally mean "something moved and was
      // judged too small". Reporting the biggest change actually observed —
      // selected or not — separates the two, and the second case has an obvious
      // next move the model can take without asking the user.
      const peak = peakChange(candidates)
      header.push(
        peak && peak.change > 0
          ? `Nothing cleared the bar for a second frame. The largest change between consecutive samples was ${formatChange(peak.change)} of the frame at ${formatTimestamp(peak.time)}; to see it, re-run that moment with sensitivity:"high" and a narrow start/end.`
          : 'Nothing in this range changed at all, so one frame covers it.',
      )
    }
    if (selected.length >= maxFrames) {
      header.push(
        `Capped at max_frames=${String(maxFrames)} — narrow start/end to see more detail in one part of the video.`,
      )
    }
    if (droppedForSize > 0) {
      header.push(
        `${String(droppedForSize)} further frame${droppedForSize === 1 ? '' : 's'} were dropped to stay under the per-call image budget; request a narrower range or a smaller max_width for those.`,
      )
    }
    header.push('Frames follow as images, in order, named by timestamp:')

    return { result: [...header, ...lines].join('\n'), images }
  },
})

function mimeTypeForExtension(extension: string): string {
  switch (extension) {
    case '.webm':
      return 'video/webm'
    case '.mov':
      return 'video/quicktime'
    case '.mkv':
      return 'video/x-matroska'
    case '.ogv':
      return 'video/ogg'
    default:
      return 'video/mp4'
  }
}
