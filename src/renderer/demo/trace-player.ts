import type { StreamChunk } from '@shared/types'
import type { DemoTrace } from '@shared/demo-traces.ts'

/**
 * Replays a {@link DemoTrace} onto the renderer's normal chunk sink.
 *
 * The point of pacing it rather than dumping the finished turn is that every
 * animation the app has — the streaming caret, tool cards flipping from
 * running to done, the usage footer ticking up — only runs when chunks arrive
 * over time. A replayed trace therefore exercises the same code path a live
 * provider does; nothing here is a special "demo rendering" mode.
 */
export interface TracePlayerOptions {
  /** Prose streaming rate. Roughly a fast cloud model. */
  charsPerSecond?: number
  /** Characters per emitted slice — small, like provider token deltas. */
  sliceChars?: number
  /** Pause between steps, on top of each step's own `delayMs`. */
  stepPauseMs?: number
  /** Emit everything with no waiting (reduced motion, or tests). */
  instant?: boolean
  signal?: AbortSignal
  /** Injectable for tests; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_CHARS_PER_SECOND = 240
const DEFAULT_SLICE_CHARS = 12
const DEFAULT_STEP_PAUSE_MS = 260

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Split text into token-sized slices that end on word boundaries where one is
 * near, so the streaming text never breaks mid-word for more than a frame.
 */
export function sliceForStreaming(text: string, sliceChars: number): string[] {
  if (text === '') return []
  const slices: string[] = []
  let index = 0
  while (index < text.length) {
    let end = Math.min(index + sliceChars, text.length)
    if (end < text.length) {
      const boundary = text.lastIndexOf(' ', end)
      if (boundary > index) end = boundary + 1
    }
    slices.push(text.slice(index, end))
    index = end
  }
  return slices
}

/** Emit one trace onto `emit`, resolving once its final chunk has been sent. */
export async function playTrace(
  trace: DemoTrace,
  emit: (chunk: StreamChunk) => void,
  options: TracePlayerOptions = {},
): Promise<void> {
  const {
    charsPerSecond = DEFAULT_CHARS_PER_SECOND,
    sliceChars = DEFAULT_SLICE_CHARS,
    stepPauseMs = DEFAULT_STEP_PAUSE_MS,
    instant = false,
    signal,
    sleep = defaultSleep,
  } = options

  const pause = async (ms: number): Promise<void> => {
    if (instant || ms <= 0) return
    await sleep(ms)
  }
  const aborted = (): boolean => signal?.aborted === true

  for (const step of trace.steps) {
    if (aborted()) return
    await pause(step.delayMs ?? stepPauseMs)
    if (aborted()) return
    const { chunk } = step
    // Prose streams a slice at a time; everything else is a single event that
    // already arrives atomically from a provider.
    if (chunk.type === 'text' || chunk.type === 'reasoning') {
      for (const slice of sliceForStreaming(chunk.text, sliceChars)) {
        if (aborted()) return
        emit({ type: chunk.type, text: slice })
        await pause((slice.length / charsPerSecond) * 1000)
      }
      continue
    }
    emit(chunk)
  }
}
