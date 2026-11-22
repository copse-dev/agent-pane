import { errorMessage } from '@shared/errors.ts'
import { classifyAcpAuthFailure, classifyProviderAccessFailure } from './agent-errors.ts'

/**
 * Per-thread circuit breaker for helper tools (`advisor`, `explore`) that
 * consult a *different* model than the executor. When that model fails for a
 * reason no retry inside the thread can fix — the advisor's agent needs
 * sign-in, the routed LM Studio server is not running — every further call
 * still costs the executor a full round trip (one observed thread spent ~3M
 * input tokens on 43 identical "Authentication required" advisor results).
 *
 * A trip is keyed by thread + tool and remembers the model *selection* it
 * failed on. It clears when that selection changes (the user picked another
 * model for the role) or after {@link TOOL_BREAKER_COOLDOWN_MS}, whichever is
 * first. The cooldown is the recovery path for fixes Copse cannot observe —
 * signing an ACP agent back in, starting LM Studio — and bounds the cost of a
 * stale trip to one probe per cooldown.
 *
 * State is in-memory on purpose: an app restart is itself a reasonable moment
 * to probe again, and nothing here is worth persisting into the thread store.
 */

/** Why a helper model cannot be used for the rest of the thread. */
export type UnrecoverableToolFailure = 'auth' | 'credit' | 'unreachable'

export type BreakerToolName = 'advisor' | 'explore'

export const TOOL_BREAKER_COOLDOWN_MS = 15 * 60_000

/**
 * Transport-level failures that mean "nothing is listening": the OpenAI SDK's
 * `APIConnectionError` ("Connection error."), Node's `fetch failed`, and the raw
 * socket codes. Only treated as unrecoverable for a local server (see
 * {@link classifyUnrecoverableToolFailure}); for a cloud model they are usually
 * a network blip.
 */
const UNREACHABLE_RE =
  /\bconnection error\b|connection refused|\bECONNREFUSED\b|\bEHOSTUNREACH\b|\bENOTFOUND\b|fetch failed|socket hang up|could not connect|failed to connect/i

/** A refused connection to this machine is unambiguous whatever the model id says. */
const LOOPBACK_REFUSED_RE = /ECONNREFUSED\s+(?:127\.0\.0\.1|::1|localhost|\[::1\])/i

/**
 * Classify a helper-model failure as one that will recur on every retry in
 * this thread. Returns `null` for anything that may be transient (rate limits,
 * overload, 5xx, timeouts, a cloud network blip) or unrelated to the model.
 *
 * `localServer` says whether the model that was called runs on this machine
 * (LM Studio, or a local OpenAI-compatible extra provider such as Ollama); it
 * decides whether a connection failure means "the server is not running".
 */
export function classifyUnrecoverableToolFailure(
  err: unknown,
  localServer: boolean,
): UnrecoverableToolFailure | null {
  if (classifyAcpAuthFailure(err) !== null) return 'auth'
  const access = classifyProviderAccessFailure(err)
  if (access === 'auth') return 'auth'
  if (access === 'credit') return 'credit'
  const text = errorMessage(err)
  // ACP agents relay their sign-in failures as plain text; classifyAcpAuthFailure
  // only trusts the JSON-RPC code without an agent id, so read the words here.
  if (
    /authentication[\s_-]*(?:required|failed)|not (?:logged|signed) in|unauthenticated|invalid api key/i.test(
      text,
    )
  )
    return 'auth'
  if (LOOPBACK_REFUSED_RE.test(text)) return 'unreachable'
  if (localServer && UNREACHABLE_RE.test(text)) return 'unreachable'
  return null
}

interface Trip {
  selection: string
  model: string
  reason: UnrecoverableToolFailure
  detail: string
  at: number
}

export interface ToolBreakerTrip {
  model: string
  reason: UnrecoverableToolFailure
  detail: string
}

/**
 * Open/closed state for every thread's helper tools. Production shares
 * {@link toolCircuitBreaker}; tests construct their own with an injected clock.
 */
export class ToolCircuitBreaker {
  private readonly trips = new Map<string, Trip>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  private key(threadId: string, tool: BreakerToolName): string {
    return `${threadId}\u0000${tool}`
  }

  /**
   * The live trip for this thread's tool on `selection`, or null. A trip
   * recorded against another selection, or older than the cooldown, is
   * discarded (the breaker closes and the next call probes again).
   */
  get(threadId: string, tool: BreakerToolName, selection: string): ToolBreakerTrip | null {
    const key = this.key(threadId, tool)
    const trip = this.trips.get(key)
    if (!trip) return null
    if (trip.selection !== selection || this.now() - trip.at >= TOOL_BREAKER_COOLDOWN_MS) {
      this.trips.delete(key)
      return null
    }
    return { model: trip.model, reason: trip.reason, detail: trip.detail }
  }

  /**
   * Record a failure of `model` (chosen by `selection`). Returns the trip when
   * the failure is unrecoverable and the breaker is now open, or null when it
   * may be transient and nothing changed.
   */
  record(
    threadId: string,
    tool: BreakerToolName,
    failure: { selection: string; model: string; localServer: boolean; error: unknown },
  ): ToolBreakerTrip | null {
    const reason = classifyUnrecoverableToolFailure(failure.error, failure.localServer)
    if (!reason) return null
    const detail = errorMessage(failure.error).trim()
    this.trips.set(this.key(threadId, tool), {
      selection: failure.selection,
      model: failure.model,
      reason,
      detail,
      at: this.now(),
    })
    return { model: failure.model, reason, detail }
  }
}

export const toolCircuitBreaker = new ToolCircuitBreaker()

function remedy(trip: ToolBreakerTrip, roleLabel: string): string {
  switch (trip.reason) {
    case 'auth':
      return `\`${trip.model}\` needs you to sign in again (or its API key was rejected). Sign in to that provider or agent, or choose a different model for the ${roleLabel} role in Settings → Models.`
    case 'credit':
      return `The provider account for \`${trip.model}\` is out of credit. Add credit, or choose a different model for the ${roleLabel} role in Settings → Models.`
    case 'unreachable':
      return `\`${trip.model}\` runs on a local server that is not reachable — is LM Studio running with that model available? Start it, or choose a different model for the ${roleLabel} role in Settings → Models.`
  }
}

/**
 * The advisor's tool result once its breaker is open: actionable for the user
 * (who reads it on the tool card) and an explicit stop for the executor.
 */
export function advisorUnavailableMessage(trip: ToolBreakerTrip): string {
  return [
    `The advisor is unavailable for the rest of this thread. ${remedy(trip, 'Advisor')}`,
    `Do not call the advisor tool again in this thread; continue the task without it.`,
    trip.detail ? `Underlying error: ${trip.detail}` : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n\n')
}

/** Shown on the explore card when the routed model failed and the parent model took over. */
export function exploreFallbackNotice(trip: ToolBreakerTrip): string {
  return `Explore now runs on this thread's main model. ${remedy(trip, 'Research')}`
}
