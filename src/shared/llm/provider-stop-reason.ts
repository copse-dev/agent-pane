/** Normalized provider stop reason on stream `done` chunks (Anthropic stop_reason / OpenAI finish_reason). */

export function isTruncationStopReason(reason: string | undefined): boolean {
  return reason === 'max_tokens' || reason === 'length'
}

export function isRefusalStopReason(reason: string | undefined): boolean {
  return reason === 'refusal' || reason === 'content_filter'
}

export function isContextOverflowStopReason(reason: string | undefined): boolean {
  return reason === 'model_context_window_exceeded'
}

export const REFUSAL_USER_MESSAGE = 'The model declined to complete this request.'
export const CONTEXT_OVERFLOW_USER_MESSAGE =
  'The conversation exceeded the model context window. Compacting history and continuing.'
export const TRUNCATION_CONTINUE_NUDGE =
  'Your previous response was cut off due to length limits. Continue briefly from where you left off.'

/**
 * Nudge after a pure-reasoning stream was cut off by the per-stream output cap
 * ({@link isStreamOutputRunaway}). The model spent a whole stream "thinking" with
 * no answer and no tool call. Because reasoning never lands in history, the normal
 * {@link TRUNCATION_CONTINUE_NUDGE} ("continue from where you left off") has nothing
 * to continue and just re-primes the same loop. This instead forces a final answer.
 */
export const REASONING_RUNAWAY_FORCE_ANSWER_NUDGE =
  'You spent your entire response on internal reasoning without answering, and it was cut off. ' +
  'Stop reasoning now and give your best final answer directly and briefly.'

/**
 * Surfaced when a model ignores {@link REASONING_RUNAWAY_FORCE_ANSWER_NUDGE} and
 * runs the per-stream cap again on reasoning alone — it is stuck looping, so the
 * run ends cleanly instead of re-priming until the wall-clock deadline fires.
 */
export const REASONING_RUNAWAY_GIVEUP_MESSAGE =
  'The model got stuck repeating its reasoning without producing an answer.'
