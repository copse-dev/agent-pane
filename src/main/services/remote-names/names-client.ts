import { toBase64Url } from '@copse/remote-protocol/encoding.ts'
import type { DevicePublicKey } from '@copse/remote-protocol/keys.ts'
import {
  CertificateResponse,
  DeviceStatusResponse,
  ErrorResponse,
  RegisterResponse,
} from '@copse/remote-protocol/messages.ts'
import { signRequestHeaders } from '@copse/remote-protocol/signing.ts'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'

export const DEFAULT_NAMES_API = 'https://api.copse.dev'
const REQUEST_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 256 * 1024

/** A device key as the client needs it: the signer and the name the service knows it by. */
export interface NamesDeviceKey {
  privateKey: CryptoKey
  publicKey: DevicePublicKey
  thumbprint: string
}

/** A refusal or failure from the names API, with what the UI and the scheduler need. */
export class NamesApiError extends Error {
  /** HTTP status, or 0 when the service could not be reached at all. */
  readonly status: number
  /** The service's machine-readable code (`rate_limited`, `invalid_invite`, …), if any. */
  readonly code: string | null
  /** Seconds the service asked us to wait (`Retry-After`), if it said. */
  readonly retryAfterSeconds: number | null

  constructor(
    message: string,
    status: number,
    code: string | null,
    retryAfterSeconds: number | null,
  ) {
    super(message)
    this.name = 'NamesApiError'
    this.status = status
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>

/**
 * The device side of the names API. Every call is signed afresh: the service
 * refuses a reused nonce and a timestamp more than five minutes off, so a retry
 * must come back through here rather than resend earlier headers.
 */
export class NamesClient {
  private readonly baseUrl: string
  private readonly key: NamesDeviceKey
  private readonly fetch: Fetch
  private readonly now: () => number

  constructor(options: {
    baseUrl: string
    key: NamesDeviceKey
    fetch?: Fetch
    now?: () => number
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.key = options.key
    this.fetch = options.fetch ?? ((input, init): Promise<Response> => fetch(input, init))
    this.now = options.now ?? Date.now
  }

  async register(invite: string): Promise<RegisterResponse> {
    const body = await this.call('POST', '/v1/register', { publicKey: this.key.publicKey, invite })
    return this.decode(body, RegisterResponse)
  }

  async setAddress(address: string): Promise<void> {
    await this.call('POST', '/v1/address', { address })
  }

  async certificate(csr: Uint8Array): Promise<CertificateResponse> {
    const body = await this.call('POST', '/v1/certificate', { csr: toBase64Url(csr) })
    return this.decode(body, CertificateResponse)
  }

  async status(): Promise<DeviceStatusResponse> {
    return this.decode(await this.call('GET', '/v1/device'), DeviceStatusResponse)
  }

  async remove(): Promise<void> {
    await this.call('DELETE', '/v1/device')
  }

  private decode<T>(text: string, schema: { safeParse: (value: unknown) => SafeParse<T> }): T {
    const value = safeJsonParse(text, decodeWithSchema(schema))
    if (value === null)
      throw new NamesApiError('The Copse names service sent an unexpected reply.', 200, null, null)
    return value
  }

  private async call(method: string, path: string, body?: unknown): Promise<string> {
    const bytes =
      body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body))
    const headers = await signRequestHeaders(
      this.key.privateKey,
      this.key.thumbprint,
      method,
      path,
      bytes,
      this.now(),
    )
    let response: Response
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: bytes }),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      throw new NamesApiError('Could not reach the Copse names service.', 0, null, null)
    }
    const text = await readBounded(response)
    if (response.ok) return text
    const error = safeJsonParse(text, decodeWithSchema(ErrorResponse))
    const retryAfter = Number(response.headers.get('retry-after'))
    throw new NamesApiError(
      error?.message ?? `The Copse names service answered ${String(response.status)}.`,
      response.status,
      error?.error ?? null,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    )
  }
}

type SafeParse<T> = { success: true; data: T } | { success: false }

async function readBounded(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new NamesApiError(
      'The Copse names service sent an oversized reply.',
      response.status,
      null,
      null,
    )
  }
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES)
    throw new NamesApiError(
      'The Copse names service sent an oversized reply.',
      response.status,
      null,
      null,
    )
  return text
}
