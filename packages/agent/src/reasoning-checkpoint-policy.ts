import { MAX_STREAM_OUTPUT_TOKENS } from './agent-loop-limits.ts'
import type { ReasoningCheckpointPolicy } from './reasoning-circle-detector.ts'

/** Reassess reasoning-dominated streams after every 2K estimated output tokens. */
export const PRODUCT_REASONING_CHECKPOINT_INTERVAL_TOKENS = 2_048

/** One bounded recovery stream after a reasoning circle is cut. */
export const PRODUCT_REASONING_RECOVERY_MAX_TOKENS = 4_096

/** Ignore a short visible preamble when the rest of a stream is reasoning. */
export const PRODUCT_REASONING_CHECKPOINT_TEXT_TOLERANCE_CHARS = 256

/**
 * Product policy for internal Copse agent loops. Ordinary visible responses retain
 * the existing 32K ceiling; only reasoning-dominated streams are reconsidered at
 * each 2K checkpoint.
 */
export const PRODUCT_REASONING_CHECKPOINT_POLICY: Readonly<ReasoningCheckpointPolicy> = {
  intervalTokens: PRODUCT_REASONING_CHECKPOINT_INTERVAL_TOKENS,
  maxNonReasoningTokens: MAX_STREAM_OUTPUT_TOKENS,
  maxInitialTokens: MAX_STREAM_OUTPUT_TOKENS,
  maxRecoveryTokens: PRODUCT_REASONING_RECOVERY_MAX_TOKENS,
}
