/**
 * Label grants (plan decision 8): produced by the Mac at pairing, shown as a QR code, scanned by
 * the shell and redeemed once with the names API. Without a grant signed by the label's own
 * device key, a shell account cannot list a label or gain reach to it.
 */
import { signText, verifyText } from './keys.ts'
import { newNonce } from './signing.ts'
import type { LabelGrant } from './messages.ts'

export const GRANT_LIFETIME_MS = 10 * 60 * 1000

export function grantSigningText(label: string, id: string, expiresMs: number): string {
  return ['copse-grant-v1', label, id, String(expiresMs)].join('\n')
}

export async function createGrant(
  privateKey: CryptoKey,
  label: string,
  nowMs: number = Date.now(),
): Promise<LabelGrant> {
  const id = newNonce()
  const expiresMs = nowMs + GRANT_LIFETIME_MS
  const signature = await signText(privateKey, grantSigningText(label, id, expiresMs))
  return { v: 1, label, id, expiresMs, signature }
}

export async function verifyGrantSignature(
  publicKey: CryptoKey,
  grant: LabelGrant,
): Promise<boolean> {
  return verifyText(publicKey, grantSigningText(grant.label, grant.id, grant.expiresMs), grant.signature)
}
