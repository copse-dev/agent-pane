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
