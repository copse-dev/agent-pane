/** Reason a provider stream was cut before natural completion. */
export type StreamCutReason = 'reasoning_runaway_cap' | 'reasoning_circle_detected'

/** Max reasoning body stored in stream-stats (256 KiB); larger cuts are truncated. */
export const MAX_STREAM_CUT_REASONING_CHARS = 256 * 1024

export interface TruncatedReasoningBody {
  text: string
  truncated: boolean
}

/** Truncate reasoning text for durable stats without blocking the loop. */
export function truncateStreamCutReasoning(
  reasoningText: string,
  maxChars = MAX_STREAM_CUT_REASONING_CHARS,
): TruncatedReasoningBody {
  if (reasoningText.length <= maxChars) {
    return { text: reasoningText, truncated: false }
  }
  return { text: reasoningText.slice(0, maxChars), truncated: true }
}

/**
 * Payload emitted when the in-loop per-stream output cap cuts a stream (#489).
 * The host persists this for eval/review; the loop never imports storage.
 */
export interface StreamCutRecord {
  /** 1-based LLM call index within this run (matches hook_run step). */
  step: number
  cutReason: StreamCutReason
  /** Configured token estimate at which this particular stream was cut. */
  streamOutputTokenLimit?: number | undefined
  streamOutputChars: number
  streamReasoningChars: number
  reasoningText: string
  reasoningTextTruncated: boolean
  hasToolCalls: boolean
  toolCallCount: number
  stopReason: string
  streamCappedAsRunaway: true
  /** Streak before any increment for this cut. */
  reasoningRunawayStreak: number
  /** Whether the reasoning-runaway nudge will be injected for this cut. */
  willInjectReasoningRunawayNudge: boolean
}
