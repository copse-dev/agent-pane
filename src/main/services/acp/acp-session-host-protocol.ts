/** Environment-carried startup request for the standalone ACP session host. */
export const ACP_SESSION_HOST_REQUEST_ENV = 'COPSE_ACP_SESSION_HOST_REQUEST'

export type AcpSessionHostMessage =
  | { type: 'ready' }
  | { type: 'error'; error: string }
  | { type: 'network-denial'; host: string; port?: number }
