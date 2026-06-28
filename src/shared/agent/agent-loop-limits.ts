/** Hard cap on provider.stream invocations per agent run (main or subagent). */
export const DEFAULT_MAX_LLM_CALLS = 40

/** Idle budget for a run; resets on {@link AgentRunDeadline.recordActivity}. */
export const AGENT_RUN_IDLE_TIMEOUT_MS = 15 * 60 * 1000

/** @deprecated use {@link AGENT_RUN_IDLE_TIMEOUT_MS} */
export const AGENT_RUN_TIMEOUT_MS = AGENT_RUN_IDLE_TIMEOUT_MS

/** Absolute wall-clock cap on a single agent run regardless of activity. */
export const AGENT_RUN_HARD_MAX_MS = 60 * 60 * 1000

/** AbortSignal.reason set when the run idle/hard deadline fires. */
export const AGENT_RUN_ABORT_REASON_TIMEOUT = 'copse:agent-run-timeout'

/** Subagent inner loops: step budget plus headroom for finalize / forced text. */
export function defaultMaxLlmCallsForSteps(maxSteps: number): number {
  return Math.min(DEFAULT_MAX_LLM_CALLS, maxSteps + 3)
}

/** @deprecated use {@link AgentRunDeadline.isExpired} */
export function isRunPastDeadline(
  runStartedAt: number,
  runTimeoutMs: number,
  now = Date.now(),
): boolean {
  return now - runStartedAt >= runTimeoutMs
}

/**
 * Sliding idle deadline with pause support. Tool execution and LLM streaming pause
 * the idle clock; each completed stream or tool batch records activity and resets
 * the idle window. A hard wall-clock cap still applies from run start.
 */
export class AgentRunDeadline {
  private readonly runStartedAt: number
  private lastActivityAt: number
  private pauseStartedAt: number | null = null
  private accumulatedPauseMs = 0
  private readonly idleTimeoutMs: number
  private readonly hardMaxMs: number

  constructor(
    idleTimeoutMs = AGENT_RUN_IDLE_TIMEOUT_MS,
    hardMaxMs = AGENT_RUN_HARD_MAX_MS,
    now = Date.now(),
  ) {
    this.idleTimeoutMs = idleTimeoutMs
    this.hardMaxMs = hardMaxMs
    this.runStartedAt = now
    this.lastActivityAt = now
  }

  /** Monotonic clock with active and accumulated pause time subtracted. */
  private effectiveNow(now = Date.now()): number {
    const activePause = this.pauseStartedAt !== null ? now - this.pauseStartedAt : 0
    return now - this.accumulatedPauseMs - activePause
  }

  recordActivity(now = Date.now()): void {
    this.lastActivityAt = this.effectiveNow(now)
  }

  pause(now = Date.now()): void {
    if (this.pauseStartedAt === null) this.pauseStartedAt = now
  }

  resume(now = Date.now()): void {
    if (this.pauseStartedAt !== null) {
      this.accumulatedPauseMs += now - this.pauseStartedAt
      this.pauseStartedAt = null
    }
  }

  isHardExpired(now = Date.now()): boolean {
    return now - this.runStartedAt >= this.hardMaxMs
  }

  isIdleExpired(now = Date.now()): boolean {
    return this.effectiveNow(now) - this.lastActivityAt >= this.idleTimeoutMs
  }

  isExpired(now = Date.now()): boolean {
    return this.isHardExpired(now) || this.isIdleExpired(now)
  }

  msUntilExpiry(now = Date.now()): number {
    const untilHard = this.hardMaxMs - (now - this.runStartedAt)
    const untilIdle = this.idleTimeoutMs - (this.effectiveNow(now) - this.lastActivityAt)
    return Math.max(0, Math.min(untilHard, untilIdle))
  }
}

export function isAgentRunTimeoutAbort(signal?: AbortSignal): boolean {
  return signal?.aborted === true && signal.reason === AGENT_RUN_ABORT_REASON_TIMEOUT
}

export function createAgentRunAbortScheduler(
  controller: AbortController,
  deadline = new AgentRunDeadline(),
): {
  deadline: AgentRunDeadline
  schedule: () => void
  clear: () => void
} {
  let timer: ReturnType<typeof setTimeout> | null = null

  const schedule = () => {
    if (timer) clearTimeout(timer)
    if (deadline.isExpired()) {
      controller.abort(AGENT_RUN_ABORT_REASON_TIMEOUT)
      return
    }
    timer = setTimeout(
      () => {
        if (deadline.isExpired()) controller.abort(AGENT_RUN_ABORT_REASON_TIMEOUT)
        else schedule()
      },
      Math.max(1, deadline.msUntilExpiry()),
    )
  }

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  return { deadline, schedule, clear }
}
