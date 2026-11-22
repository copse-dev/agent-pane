/**
 * Why an ACP turn released its execution context. Kept dependency-free so the
 * stdout-owning ACP client can use it without importing the approval service.
 */
export type AcpTurnEndReason =
  | 'completed'
  /**
   * Send-now interrupted the turn. A waiting call ends and no recovery wake is
   * requested, but this is not a revocation: parked prompts and saved answers
   * stay for the same task, as on `completed` (hooks plan decision 4).
   */
  | 'send-now'
  | 'stopped'
  | 'idle-timeout'
  | 'session-closed'
  | 'failed'

export class AcpTurnEnded extends Error {
  override readonly name = 'AcpTurnEnded'

  readonly reason: AcpTurnEndReason

  constructor(reason: AcpTurnEndReason) {
    super(`Agent turn ended: ${reason}`)
    this.reason = reason
  }
}

/** End reason for a turn whose run signal aborted: send-now, or any other abort as a Stop. */
export function abortedTurnEndReason(signal: AbortSignal): 'send-now' | 'stopped' {
  return signal.reason === 'send_now' ? 'send-now' : 'stopped'
}
