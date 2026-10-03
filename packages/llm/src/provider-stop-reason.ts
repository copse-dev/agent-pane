/** Normalized provider stop reason on stream `done` chunks (Anthropic stop_reason / OpenAI finish_reason). */

export function isTruncationStopReason(reason: string | undefined): boolean {
  return reason === 'max_tokens' || reason === 'length'
}

/**
 * Stop reason of a stream whose tool call the provider could not parse (a call
 * cut off at the output ceiling, or malformed JSON/markup). The stream ends
 * normally with this reason instead of throwing, so the agent loop can recover:
 * replaying the identical prompt would reproduce the same broken call, but a
 * nudge asking for a much smaller call usually does not.
 */
export const TOOL_CALL_MALFORMED_STOP_REASON = 'tool_call_malformed'

export function isMalformedToolCallStopReason(reason: string | undefined): boolean {
  return reason === TOOL_CALL_MALFORMED_STOP_REASON
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
 * Rung 2 of the reasoning-runaway recovery ladder: sent with a reasoning-suppressed,
 * tightly capped, tool-enabled recovery turn after the force-answer nudge was itself
 * ignored. It asks for one bounded concrete step (a tool call) rather than an answer,
 * because a model that cannot finish reasoning about a whole task can usually still
 * emit its first command.
 */
export const REASONING_RUNAWAY_SUPPRESSED_NUDGE =
  'Your reasoning was cut off twice with no action taken. Do not think any further. ' +
  'Take exactly one concrete next step right now by calling a tool (for example, run the first ' +
  'shell command or write the first file the task needs). Reply with the tool call only.'

/** `done.stopReason` when the recovery ladder is exhausted and the run is abandoned. */
export const REASONING_RUNAWAY_EXHAUSTED_STOP_REASON = 'reasoning_runaway_exhausted'

/**
 * Surfaced when every rung of the reasoning-runaway recovery ladder (force-answer
 * nudge, then a reasoning-suppressed tool-enabled turn) still ended in a reasoning-only
 * cut — the model is stuck looping, so the run ends with a terminal
 * {@link REASONING_RUNAWAY_EXHAUSTED_STOP_REASON} instead of re-priming until the
 * wall-clock deadline fires.
 */
export const REASONING_RUNAWAY_GIVEUP_MESSAGE =
  'The model got stuck repeating its reasoning without producing an answer.'

/** Nudge after a tool call was cut off at the per-request output ceiling. */
export const TRUNCATED_TOOL_CALL_NUDGE =
  'Your malformed tool call was cut off because it hit the output length limit, so that call was discarded and did not run. ' +
  'Emit a much smaller call. Write large files in several short pieces (for example appending with shell heredocs), ' +
  'or write a smaller first version and extend it afterwards. Keep any reasoning brief.'

/** Nudge after a tool call could not be parsed for a reason other than the ceiling. */
export const MALFORMED_TOOL_CALL_NUDGE =
  'Your malformed tool call could not be parsed, so that call was discarded and did not run. ' +
  'Emit a smaller, well-formed call with valid arguments. Write large files in several short pieces ' +
  '(for example appending with shell heredocs) rather than one large call.'

/**
 * Recovery bounds for `tool_call_malformed` streams. Past either, the loop fails
 * the run with the provider's parse error (the behaviour before recovery
 * existed) instead of looping to the wall-clock deadline.
 */
export const MAX_CONSECUTIVE_MALFORMED_TOOL_CALLS = 2
export const MAX_MALFORMED_TOOL_CALLS_PER_RUN = 4
