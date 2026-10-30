/**
 * Device-signed requests to the names API. Every device endpoint carries these headers; the
 * service checks freshness (±5 minutes), refuses a nonce it has already seen for the key, and
 * verifies the signature over the canonical string below.
 */
import { sha256, toBase64Url } from './encoding.ts'
import { signText } from './keys.ts'

export const HEADER_KEY = 'copse-key'
export const HEADER_TIMESTAMP = 'copse-timestamp'
export const HEADER_NONCE = 'copse-nonce'
export const HEADER_SIGNATURE = 'copse-signature'

/** Nonces are 16 to 64 base64url characters (at least 96 bits when generated as 16 bytes). */
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
/** Thumbprints are SHA-256, so exactly 43 base64url characters. */
export const THUMBPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/

export interface SignedRequestParts {
  readonly method: string
  /** Path and query exactly as sent, e.g. `/v1/address`. */
  readonly path: string
  readonly timestampMs: number
  readonly nonce: string
  readonly body: Uint8Array
}

export async function canonicalRequest(parts: SignedRequestParts): Promise<string> {
  return [
    'copse-request-v1',
    parts.method.toUpperCase(),
    parts.path,
    String(parts.timestampMs),
    parts.nonce,
    toBase64Url(await sha256(parts.body)),
  ].join('\n')
}

export function newNonce(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(18)))
}

/** Build the headers for a signed request; used by the Mac client and by tests. */
export async function signRequestHeaders(
  privateKey: CryptoKey,
  thumbprint: string,
  method: string,
  path: string,
  body: Uint8Array,
  nowMs: number = Date.now(),
): Promise<Record<string, string>> {
  const nonce = newNonce()
  const text = await canonicalRequest({ method, path, timestampMs: nowMs, nonce, body })
  return {
    [HEADER_KEY]: thumbprint,
    [HEADER_TIMESTAMP]: String(nowMs),
    [HEADER_NONCE]: nonce,
    [HEADER_SIGNATURE]: await signText(privateKey, text),
  }
}
