/**
 * Why an ACP turn released its execution context. Kept dependency-free so the
 * stdout-owning ACP client can use it without importing the approval service.
 */
export type AcpTurnEndReason =
  | 'completed'
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
