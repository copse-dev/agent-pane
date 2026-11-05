/**
 * Device keys: ECDSA P-256 (plan decision 13), exchanged as public JWKs and named by their
 * RFC 7638 thumbprint. Signatures use WebCrypto's IEEE P1363 encoding (64 bytes, r || s).
 */
import { z } from 'zod'

import { fromBase64Url, sha256, toBase64Url, utf8 } from './encoding.ts'

const coordinate = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'a P-256 coordinate is 32 bytes of base64url')

/** A P-256 public key. Private members (`d`) and any other field are refused. */
export const DevicePublicKey = z.strictObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: coordinate,
  y: coordinate,
})
export type DevicePublicKey = z.infer<typeof DevicePublicKey>

const ALGORITHM: EcKeyImportParams = { name: 'ECDSA', namedCurve: 'P-256' }
const SIGN: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' }

/** RFC 7638 thumbprint: SHA-256 over the required members in lexicographic order. */
export async function keyThumbprint(key: DevicePublicKey): Promise<string> {
  const canonical = JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y })
  return toBase64Url(await sha256(utf8(canonical)))
}

/** Import a public JWK, returning null for a point that is not on the curve. */
export async function importDevicePublicKey(key: DevicePublicKey): Promise<CryptoKey | null> {
  try {
    return await crypto.subtle.importKey('jwk', { ...key, ext: true }, ALGORITHM, true, ['verify'])
  } catch {
    return null
  }
}

export async function generateDeviceKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify'])
}

export async function exportDevicePublicKey(key: CryptoKey): Promise<DevicePublicKey> {
  return DevicePublicKey.parse(pick(await crypto.subtle.exportKey('jwk', key)))
}

function pick(jwk: JsonWebKey): Record<string, unknown> {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
}

export async function signText(privateKey: CryptoKey, text: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, utf8(text))))
}

/** Verify a base64url P1363 signature over `text`. Malformed input is simply invalid. */
export async function verifyText(
  publicKey: CryptoKey,
  text: string,
  signature: string,
): Promise<boolean> {
  const bytes = fromBase64Url(signature)
  if (!bytes || bytes.length !== 64) return false
  try {
    return await crypto.subtle.verify(SIGN, publicKey, bytes, utf8(text))
  } catch {
    return false
  }
}
