/** Hard cap on provider.stream invocations per agent run (main or subagent). */
export const DEFAULT_MAX_LLM_CALLS = 40

/**
 * Hard cap on output (text + reasoning) tokens produced by a single
 * provider.stream call. Cloud providers cap output via the request `max_tokens`
 * field, but OpenAI-compatible servers (e.g. LM Studio, Ollama) often ignore or
 * lack it, so a local model can stream indefinitely until the run idle/hard
 * deadline finally fires — minutes of generation with no answer (#489). This is
 * a coarse per-stream backstop, intentionally generous so it only trips on
 * genuine runaways, not normal long answers.
 */
export const MAX_STREAM_OUTPUT_TOKENS = 32_000

import { CHARS_PER_TOKEN } from './token-estimate.ts'

/**
 * True once a single stream's accumulated output characters exceed
 * {@link MAX_STREAM_OUTPUT_TOKENS}. Counts text and reasoning together so a model
 * that "thinks" forever is caught as readily as one that answers forever.
 */
export function isStreamOutputRunaway(
  outputChars: number,
  maxOutputTokens: number | undefined = MAX_STREAM_OUTPUT_TOKENS,
): boolean {
  return outputChars / CHARS_PER_TOKEN >= maxOutputTokens
}

/** Idle budget for a run; resets on {@link AgentRunDeadline.recordActivity}. */
export const AGENT_RUN_IDLE_TIMEOUT_MS = 15 * 60 * 1000

/** Absolute wall-clock cap on a single agent run regardless of activity. */
export const AGENT_RUN_HARD_MAX_MS = 60 * 60 * 1000

/**
 * Adaptive budget extension: LLM calls granted each time a healthy-but-long run
 * exhausts its budget, up to {@link MAX_EXTENSION_GRANTS} times. Extensions are
 * the variadic alternative to a flat higher cap — runs that are making distinct
 * progress get room to finish; runs that are thrashing end exactly as before.
 */
export const EXTENSION_GRANT_LLM_CALLS = 12

/** Maximum adaptive extensions per run (so the worst case stays bounded). */
export const MAX_EXTENSION_GRANTS = 2

/**
 * Recent tool-call window inspected when deciding an extension: a run whose
 * last N tool calls were all repeats is stuck, whatever its other signals say.
 */
export const EXTENSION_HEALTH_WINDOW = 8

/** Distinct tool calls required in the health window before a grant fires. */
const MIN_DISTINCT_TOOL_CALLS_FOR_EXTENSION = 2

/**
 * Signals summarising how the most recent part of a run went, fed to
 * {@link shouldExtendRunBudget}. Populated by the agent loop from state it
 * already tracks (recent tool-call fingerprints, nudge flags).
 */
export interface ExtensionHealthSignals {
  /** Distinct (non-duplicate) tool-call fingerprints in the recent window. */
  readonly distinctRecentToolCalls: number
  /** Consecutive reasoning-only streams cut and re-nudged without progress. */
  readonly reasoningRunawayStreak: number
  /** Whether a loop or forced-finalize nudge fired during the run. */
  readonly nudged: boolean
}

/**
 * Whether an exhausted call budget extends for one more grant. A run earns the
 * room by showing distinct recent tool activity and none of the stuck-signals;
 * anything else ends the run exactly as an unextended budget would. Pure so the
 * policy is testable without spinning the loop.
 */
export function shouldExtendRunBudget(
  signals: ExtensionHealthSignals,
  grantsUsed: number,
  maxGrants: number = MAX_EXTENSION_GRANTS,
): boolean {
  if (grantsUsed >= maxGrants) return false
  if (signals.reasoningRunawayStreak > 0 || signals.nudged) return false
  return signals.distinctRecentToolCalls >= MIN_DISTINCT_TOOL_CALLS_FOR_EXTENSION
}

/** Host-declared loop bounds for a run; absent keys use product defaults. */
export interface AgentLoopRunProfile {
  /** Max provider.stream calls for the main loop. */
  readonly maxLlmCalls?: number
  /** Max loop steps for the main loop. */
  readonly maxSteps?: number
  /**
   * Whether the loop may extend its own budget when the run is healthy but long
   * (defaults to true).
   */
  readonly adaptiveExtensions?: boolean
}

/** AbortSignal.reason set when the run idle/hard deadline fires. */
export const AGENT_RUN_ABORT_REASON_TIMEOUT = 'copse:agent-run-timeout'

/** Subagent inner loops: step budget plus headroom for finalize / forced text. */
export function defaultMaxLlmCallsForSteps(maxSteps: number): number {
  return Math.min(DEFAULT_MAX_LLM_CALLS, maxSteps + 3)
}

/** Optional knobs for {@link AgentRunDeadline}, kept off the positional args. */
export interface AgentRunDeadlineOptions {
  /**
   * Exclude paused time from the wall-clock hard cap (#2332).
   *
   * The local loop leaves this off: its pauses are its own tool execution and
   * streaming, which is precisely the work the runaway budget exists to bound.
   * A host-driven run (the ACP branch) turns it on, because there the pauses are
   * approval modals — time spent blocked on a human. Blocking indefinitely on an
   * approval prompt is intended behaviour, so it must not spend the run's
   * runaway-work budget; without this an ACP turn is killed underneath a prompt
   * the user can still see, and the kill is indistinguishable from Stop.
   *
   * The cap itself stays armed, so a run that never pauses — including one whose
   * blocking site forgot to register an idle pause — is still bounded.
   */
  readonly excludePausesFromHardMax?: boolean
}

/**
 * Sliding idle deadline with pause support. Tool execution and LLM streaming pause
 * the idle clock; each completed stream or tool batch records activity and resets
 * the idle window. A hard wall-clock cap still applies from run start — over raw
 * wall time by default, or over unpaused time only when
 * {@link AgentRunDeadlineOptions.excludePausesFromHardMax} is set.
 */
export class AgentRunDeadline {
  private readonly runStartedAt: number
  private lastActivityAt: number
  private pauseStartedAt: number | null = null
  private accumulatedPauseMs = 0
  // Reference count so nested pauses compose (decision 13, H4): a blocking hook
  // that fires *inside* an already-paused region (e.g. a `toolGate` hook during
  // `executeToolBatch`'s pause) pauses/resumes the same deadline without the
  // inner `resume` prematurely un-pausing the outer region. Only the outermost
  // resume records the elapsed pause; a single pause/resume pair (the pre-H4
  // usage) behaves exactly as before.
  private pauseDepth = 0
  private readonly idleTimeoutMs: number
  private readonly hardMaxMs: number
  private readonly clock: () => number
  private readonly excludePausesFromHardMax: boolean

  constructor(
    idleTimeoutMs = AGENT_RUN_IDLE_TIMEOUT_MS,
    hardMaxMs = AGENT_RUN_HARD_MAX_MS,
    now = Date.now(),
    clock: () => number = Date.now,
    options: AgentRunDeadlineOptions = {},
  ) {
    this.idleTimeoutMs = idleTimeoutMs
    this.hardMaxMs = hardMaxMs
    this.runStartedAt = now
    this.lastActivityAt = now
    this.clock = clock
    this.excludePausesFromHardMax = options.excludePausesFromHardMax ?? false
  }

  /** Monotonic clock with active and accumulated pause time subtracted. */
  private effectiveNow(now = this.clock()): number {
    const activePause = this.pauseStartedAt !== null ? now - this.pauseStartedAt : 0
    return now - this.accumulatedPauseMs - activePause
  }

  recordActivity(now = this.clock()): void {
    this.lastActivityAt = this.effectiveNow(now)
  }

  pause(now = this.clock()): void {
    if (this.pauseDepth === 0 && this.pauseStartedAt === null) this.pauseStartedAt = now
    this.pauseDepth += 1
  }

  resume(now = this.clock()): void {
    if (this.pauseDepth === 0) return
    this.pauseDepth -= 1
    // Only the outermost resume records the elapsed pause and re-arms the clock.
    if (this.pauseDepth === 0 && this.pauseStartedAt !== null) {
      this.accumulatedPauseMs += now - this.pauseStartedAt
      this.pauseStartedAt = null
    }
  }

  /**
   * Elapsed time the hard cap is measured over: raw wall time, or wall time with
   * pauses removed when the run asked for that (see
   * {@link AgentRunDeadlineOptions.excludePausesFromHardMax}).
   */
  private hardElapsedMs(now = this.clock()): number {
    if (!this.excludePausesFromHardMax) return now - this.runStartedAt
    return this.effectiveNow(now) - this.runStartedAt
  }

  isHardExpired(now = this.clock()): boolean {
    return this.hardElapsedMs(now) >= this.hardMaxMs
  }

  isIdleExpired(now = this.clock()): boolean {
    return this.effectiveNow(now) - this.lastActivityAt >= this.idleTimeoutMs
  }

  isExpired(now = this.clock()): boolean {
    return this.isHardExpired(now) || this.isIdleExpired(now)
  }

  msUntilExpiry(now = this.clock()): number {
    const untilHard = this.hardMaxMs - this.hardElapsedMs(now)
    const untilIdle = this.idleTimeoutMs - (this.effectiveNow(now) - this.lastActivityAt)
    return Math.max(0, Math.min(untilHard, untilIdle))
  }

  /**
   * Elapsed run time as the hard cap counts it. Pauses deliberately still count
   * unless the run opted out via
   * {@link AgentRunDeadlineOptions.excludePausesFromHardMax}.
   */
  elapsedWallTimeMs(now = this.clock()): number {
    return Math.max(0, this.hardElapsedMs(now))
  }

  /** Time left before the hard product cap, independent of the sliding idle window. */
  remainingWallTimeMs(now = this.clock()): number {
    return Math.max(0, this.hardMaxMs - this.elapsedWallTimeMs(now))
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

  const schedule = (): void => {
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

  const clear = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  return { deadline, schedule, clear }
}
