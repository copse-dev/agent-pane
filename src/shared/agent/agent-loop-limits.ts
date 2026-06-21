/** Hard cap on provider.stream invocations per agent run (main or subagent). */
export const DEFAULT_MAX_LLM_CALLS = 40

/** Wall-clock budget for a main agent run before AbortController fires. */
export const AGENT_RUN_TIMEOUT_MS = 15 * 60 * 1000

/** Subagent inner loops: step budget plus headroom for finalize / forced text. */
export function defaultMaxLlmCallsForSteps(maxSteps: number): number {
  return Math.min(DEFAULT_MAX_LLM_CALLS, maxSteps + 3)
}

export function isRunPastDeadline(runStartedAt: number, runTimeoutMs: number): boolean {
  return Date.now() - runStartedAt >= runTimeoutMs
}
