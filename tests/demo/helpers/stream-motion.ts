/** One animation frame of the streaming transcript, as a reader saw it. */
export interface StreamFrame {
  messageId: string
  streaming: boolean
  /** Characters of rendered text in the reply. */
  length: number
  /** Height of the reply's `.message-text`. */
  height: number
  scrollTop: number
  /** Top of each rendered block's first line, relative to its message row. */
  blockTops: number[]
}

export interface StreamMotion {
  /** Share of live frames in which more of the reply appeared. */
  advancingShare: number
  /** 90th percentile of characters revealed in one frame. */
  p90CharsPerFrame: number
  /** Largest move of a block already on screen, between consecutive live frames. */
  maxBlockShiftPx: number
  /** Largest single-frame scroll step while the reply streamed. */
  maxScrollStepPx: number
  /** Height change of the reply when the final render replaced the stream. */
  finalSwapHeightDeltaPx: number | null
  liveFrames: number
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
}

/**
 * Measure how the last reply in `windows` streamed. Each window is a run of
 * consecutive frames; nothing is compared across a gap between windows.
 */
export function analyzeStreamMotion(windows: StreamFrame[][]): StreamMotion {
  const replyId = windows.flat().at(-1)?.messageId
  let live = 0
  let advancing = 0
  const steps: number[] = []
  let maxBlockShiftPx = 0
  let maxScrollStepPx = 0
  let finalSwapHeightDeltaPx: number | null = null
  for (const frames of windows) {
    const reply = frames.filter((frame) => frame.messageId === replyId)
    for (let i = 1; i < reply.length; i++) {
      const before = reply[i - 1]
      const after = reply[i]
      if (!before || !after) continue
      if (before.streaming && !after.streaming) {
        finalSwapHeightDeltaPx = after.height - before.height
      }
      if (!before.streaming || !after.streaming) continue
      live++
      const step = after.length - before.length
      if (step > 0) {
        advancing++
        steps.push(step)
      }
      before.blockTops.forEach((top, index) => {
        const next = after.blockTops[index]
        if (next !== undefined) maxBlockShiftPx = Math.max(maxBlockShiftPx, Math.abs(next - top))
      })
      maxScrollStepPx = Math.max(maxScrollStepPx, Math.abs(after.scrollTop - before.scrollTop))
    }
  }
  return {
    advancingShare: live === 0 ? 0 : advancing / live,
    p90CharsPerFrame: percentile(steps, 0.9),
    maxBlockShiftPx,
    maxScrollStepPx,
    finalSwapHeightDeltaPx,
    liveFrames: live,
  }
}
