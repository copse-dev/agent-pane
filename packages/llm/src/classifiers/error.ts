export type ClassifierErrorCode =
  | 'invalid-request'
  | 'unsupported-capability'
  | 'authentication'
  | 'connectivity'
  | 'rate-limit'
  | 'invalid-response'
  | 'timeout'
  | 'cancelled'
  | 'process'

/** Errors intentionally omit provider response bodies and credential-bearing URLs. */
export class ClassifierError extends Error {
  readonly code: ClassifierErrorCode
  readonly status: number | undefined

  constructor(code: ClassifierErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'ClassifierError'
    this.code = code
    this.status = status
  }
}
