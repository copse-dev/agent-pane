/**
 * What the guest reads about the turn itself: whether it failed, and how
 * many tokens it has used so far. Pure, so the worker's two stop rules that
 * depend on it can be tested without a guest.
 *
 * `runHeadlessAgent` resolves whether or not the agent's turn succeeded — a
 * provider error, an agent that could not authenticate, a crash in an ACP
 * child all come back as the result's `turnOutcome` with `status: 'failed'`,
 * not as a rejection. The worker's first version only marked a run failed
 * when the call threw, so a failed turn was reported as completed with
 * whatever partial text it had. The token ceiling has the same blind spot
 * under an ACP harness: usage arrives once, after the turn, so it can only
 * be checked once the tokens are spent. What arrives live is the agent's own
 * report of its context (`usage_update`, carried as an agent-reported
 * context-pressure chunk); counting that against the ceiling is how the
 * budget binds mid-turn.
 */
import type { StreamChunk, TurnOutcome } from '@shared/types'

/** Why a turn failed, from its outcome; null when it did not, or there is none. */
export function failedTurn(outcome: TurnOutcome | undefined): string | null {
  if (outcome === undefined || outcome.status !== 'failed') return null
  if (outcome.error?.message) return outcome.error.message
  return `the agent's turn failed (${outcome.rawStopReason ?? outcome.stopReason})`
}

export interface TokenTally {
  /** Summed from the usage chunks the turn reported. */
  inputTokens: number
  outputTokens: number
  /**
   * What the agent's context reports add up to, as spending: each report is
   * the context one model call was given, so the sum over calls is the input
   * the turn has cost so far — the ceiling is a spending limit, not a size
   * limit, and a turn of many calls on a modest context is the case it has
   * to catch. A report that repeats the last one is the same call reported
   * again (a heartbeat, a tool result on the same context), not a new one,
   * and is not added.
   */
  contextTokens: number
  /** The last context report, to tell a new call from a repeat. */
  lastContextReport: number | null
}

export function newTokenTally(): TokenTally {
  return { inputTokens: 0, outputTokens: 0, contextTokens: 0, lastContextReport: null }
}

/** Fold one chunk into the tally. */
export function countTokens(tally: TokenTally, chunk: StreamChunk): void {
  if (chunk.type === 'usage') {
    tally.inputTokens += chunk.inputTokens
    tally.outputTokens += chunk.outputTokens
  } else if (chunk.type === 'context_pressure' && chunk.source === 'agent-reported') {
    if (chunk.conversationTokens !== tally.lastContextReport) {
      tally.contextTokens += chunk.conversationTokens
      tally.lastContextReport = chunk.conversationTokens
    }
  }
}

/**
 * Tokens the run has used, as far as the guest can tell: the usage it was
 * told, or what the agent's context reports add up to, whichever says more.
 * An estimate on the agent side — the agent's own accounting arrives with
 * the usage chunk once the turn is over — but one that grows with every
 * model call, which is what a ceiling on spending has to follow.
 */
export function tokensUsed(tally: TokenTally): number {
  return Math.max(tally.inputTokens + tally.outputTokens, tally.contextTokens)
}
