export type TerminalBenchTrialOutcome = 'pass' | 'zero' | 'timeout' | 'invalid'

export interface TerminalBenchOutcomeInput {
  reward: number | undefined
  exceptionType: string | undefined
}

/**
 * Harbor can still verify a solution after the agent reaches its time allowance.
 * The verifier reward is authoritative, so do not hide a solved task in the
 * timeout bucket just because cleanup also records AgentTimeoutError.
 */
export function terminalBenchTrialOutcome(
  trial: TerminalBenchOutcomeInput,
): TerminalBenchTrialOutcome {
  if (trial.reward === 1) return 'pass'
  if (trial.exceptionType === 'AgentTimeoutError') return 'timeout'
  if (trial.exceptionType !== undefined) return 'invalid'
  return 'zero'
}
