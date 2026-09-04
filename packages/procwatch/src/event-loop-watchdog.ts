/**
 * Main-process event-loop-lag watchdog (issue #995).
 *
 * When synchronous work blocks (or saturates) the main event loop, the app
 * freezes and — historically — the only way to name the culprit was hours of
 * external profiling (`kill -USR1` + CDP, see #988). A cheap monotonic heartbeat
 * observes the lag for free: a scheduled tick that arrives late means the loop
 * was blocked, so we emit one bounded, privacy-safe record.
 *
 * IMPORTANT: a heartbeat observes lag only AFTER the loop resumes; it cannot
 * recover the blocking stack. Capturing that (an inspector CPU sample) is a
 * separate, opt-in, time-bounded diagnostic and intentionally out of scope here.
 *
 * Records carry only structural data — lag, memory counters, the latest phase
 * marker, and phase durations. Never paths, prompts, commands, or file contents.
 */

export type LagSeverity = 'warn' | 'severe'

export interface MemorySample {
  rss: number
  heapUsed: number
}

export interface PhaseDuration {
  phase: string
  ms: number
}

export interface LagRecord {
  severity: LagSeverity
  /** Milliseconds the tick arrived late beyond its scheduled interval. */
  lagMs: number
  /** Additional warn+ ticks suppressed during the preceding cooldown window. */
  coalescedCount: number
  /** The most recent startup/runtime phase marker, or null if none recorded. */
  phase: string | null
  memory: MemorySample
  /** Recent phase durations (severe records only), for post-hoc timeline reading. */
  recentPhases: PhaseDuration[]
}

/**
 * A bounded ring of phase markers. Each `mark` timestamps a short, static phase
 * NAME (e.g. `window-create`) — never user content. Oldest markers are evicted
 * once capacity is exceeded, so memory stays bounded across a long session.
 */
export class PhaseRing {
  private readonly markers: Array<{ phase: string; at: number }> = []
  private readonly capacity: number
  private readonly now: () => number

  constructor(capacity: number, now: () => number) {
    this.capacity = capacity
    this.now = now
  }

  mark(phase: string): void {
    this.markers.push({ phase, at: this.now() })
    if (this.markers.length > this.capacity) this.markers.shift()
  }

  latest(): string | null {
    return this.markers.at(-1)?.phase ?? null
  }

  /** Consecutive marker deltas: how long each phase lasted before the next began. */
  durations(): PhaseDuration[] {
    const out: PhaseDuration[] = []
    for (let i = 1; i < this.markers.length; i++) {
      const prev = this.markers[i - 1]
      const cur = this.markers[i]
      if (prev && cur) out.push({ phase: prev.phase, ms: cur.at - prev.at })
    }
    return out
  }

  snapshot(): Array<{ phase: string; at: number }> {
    return this.markers.map((m) => ({ ...m }))
  }
}

export interface LagMonitorOptions {
  /** Scheduled heartbeat interval. */
  intervalMs: number
  /** Lag at or above this is a `warn` record. */
  warnMs: number
  /** Lag at or above this is a `severe` record. */
  severeMs: number
  /** After emitting, suppress (and coalesce) further records for this window. */
  cooldownMs: number
  memory: () => MemorySample
  latestPhase: () => string | null
  recentPhases: () => PhaseDuration[]
  onRecord: (record: LagRecord) => void
}

/**
 * Pure lag classifier. `observe(now)` is called once per heartbeat with the
 * current monotonic time; it computes drift against the scheduled interval and
 * emits at most one record per cooldown window. Kept free of timers so a fake
 * clock can drive every branch deterministically.
 */
export class EventLoopLagMonitor {
  private lastTickAt: number | null = null
  private lastRecordAt: number | null = null
  private suppressedSinceRecord = 0
  private readonly opts: LagMonitorOptions

  constructor(opts: LagMonitorOptions) {
    this.opts = opts
  }

  /** Prime the baseline without emitting (the first heartbeat has no prior tick). */
  prime(now: number): void {
    this.lastTickAt = now
  }

  observe(now: number): void {
    const previous = this.lastTickAt
    this.lastTickAt = now
    if (previous === null) return

    // Lag is how far beyond the scheduled interval this tick actually arrived.
    // Clamp negative jitter (an early tick) to zero.
    const lagMs = Math.max(0, now - previous - this.opts.intervalMs)
    if (lagMs < this.opts.warnMs) return

    const severity: LagSeverity = lagMs >= this.opts.severeMs ? 'severe' : 'warn'

    // Coalesce a burst of catch-up ticks from one long stall into a single
    // record so a 5s freeze does not produce hundreds of warnings.
    if (this.lastRecordAt !== null && now - this.lastRecordAt < this.opts.cooldownMs) {
      this.suppressedSinceRecord++
      return
    }

    this.lastRecordAt = now
    const coalescedCount = this.suppressedSinceRecord
    this.suppressedSinceRecord = 0
    this.opts.onRecord({
      severity,
      lagMs,
      coalescedCount,
      phase: this.opts.latestPhase(),
      memory: this.opts.memory(),
      recentPhases: severity === 'severe' ? this.opts.recentPhases() : [],
    })
  }
}

// ---------------------------------------------------------------------------
// Lifecycle singleton wiring (real clock, timer, and logger).
// ---------------------------------------------------------------------------

/** Sample twice per second: cheap, and short enough to catch sub-second stalls. */
const HEARTBEAT_INTERVAL_MS = 500
/** ~250ms of lag is already a perceptible hitch. */
const WARN_LAG_MS = 250
/** A multi-second stall is a hang worth a louder, timeline-bearing record. */
const SEVERE_LAG_MS = 2_000
/** One stall → one record; further catch-up ticks within this window coalesce. */
const RECORD_COOLDOWN_MS = 5_000
/** Enough phase history to cover startup without unbounded growth. */
const PHASE_RING_CAPACITY = 64

/** Monotonic clock in milliseconds; immune to wall-clock jumps (NTP, sleep). */
function monotonicNow(): number {
  return Number(process.hrtime.bigint() / 1_000_000n)
}

const phaseRing = new PhaseRing(PHASE_RING_CAPACITY, monotonicNow)
let heartbeat: ReturnType<typeof setInterval> | null = null

function formatRecord(record: LagRecord): string {
  const rssMb = Math.round(record.memory.rss / (1024 * 1024))
  const heapMb = Math.round(record.memory.heapUsed / (1024 * 1024))
  const parts = [
    `severity=${record.severity}`,
    `lag=${String(Math.round(record.lagMs))}ms`,
    `phase=${record.phase ?? 'unknown'}`,
    `rss=${String(rssMb)}MB`,
    `heapUsed=${String(heapMb)}MB`,
  ]
  if (record.coalescedCount > 0) parts.push(`coalesced=${String(record.coalescedCount)}`)
  if (record.recentPhases.length > 0) {
    const timeline = record.recentPhases
      .map((p) => `${p.phase}:${String(Math.round(p.ms))}ms`)
      .join(' ')
    parts.push(`timeline=[${timeline}]`)
  }
  return `[event-loop-watchdog] main loop stalled — ${parts.join(' ')}`
}

/**
 * The closed set of startup/runtime phase markers. Constraining `recordStartupPhase`
 * to this union — rather than an open `string` — makes it impossible for a call
 * site to route a dynamic path, prompt, or command into the phase ring (and thus
 * into console output). Add a new literal here to introduce a phase.
 */
export type StartupPhase =
  | 'app-ready'
  | 'reap-gortex'
  | 'tool-availability'
  | 'sandbox-init'
  | 'window-create'
  | 'register-handlers'
  | 'skills-mcp'
  | 'boot-complete'

/** Record a static startup/runtime phase marker for later lag attribution. */
export function recordStartupPhase(phase: StartupPhase): void {
  phaseRing.mark(phase)
}

/** Read the recorded phase timeline (consumed by startup-budget diagnostics, #994). */
export function getStartupPhaseTimeline(): PhaseDuration[] {
  return phaseRing.durations()
}

/**
 * Start the main-process event-loop watchdog. Idempotent. The timer is `unref`d
 * so it never keeps the process alive, and it is stopped on app shutdown.
 */
export function startEventLoopWatchdog(): void {
  if (heartbeat !== null) return
  const monitor = new EventLoopLagMonitor({
    intervalMs: HEARTBEAT_INTERVAL_MS,
    warnMs: WARN_LAG_MS,
    severeMs: SEVERE_LAG_MS,
    cooldownMs: RECORD_COOLDOWN_MS,
    memory: (): MemorySample => {
      const { rss, heapUsed } = process.memoryUsage()
      return { rss, heapUsed }
    },
    latestPhase: (): string | null => phaseRing.latest(),
    recentPhases: (): PhaseDuration[] => phaseRing.durations(),
    onRecord: (record): void => {
      console.warn(formatRecord(record))
    },
  })
  monitor.prime(monotonicNow())
  heartbeat = setInterval(() => {
    monitor.observe(monotonicNow())
  }, HEARTBEAT_INTERVAL_MS)
  heartbeat.unref()
}

/** Stop the watchdog (app shutdown). Idempotent. */
export function stopEventLoopWatchdog(): void {
  if (heartbeat !== null) {
    clearInterval(heartbeat)
    heartbeat = null
  }
}
