/** Base64url without padding (RFC 4648 section 5), the only binary encoding on the wire. */

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

const BASE64URL = /^[A-Za-z0-9_-]*$/

/** Decode base64url, refusing padding and any character outside the alphabet. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return null
  return new Uint8Array(Buffer.from(text, 'base64url'))
}

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text)
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // Copy into a fresh ArrayBuffer-backed view, which WebCrypto requires.
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
}
