/**
 * The Mac-to-relay tunnel (plan decision 7 and the implementation notes).
 *
 * 1. The Mac opens TLS to `relay.copse.dev` (the relay's own certificate).
 * 2. The relay sends one line: `{"type":"challenge","challenge":"<base64url 32 bytes>"}`.
 * 3. The Mac answers with one line: `{"type":"auth","label",...,"signature"}`, signing
 *    `tunnelSigningText(label, challenge, timestampMs)` with its device key.
 * 4. The relay answers `{"type":"ready"}` or closes the connection.
 * 5. The Mac serves HTTP/2 on the rest of the connection; the relay is the client. Each browser
 *    connection is one `CONNECT` stream for `web.<label>.u.copse.me:443` carrying the
 *    `copse-client-ip` header and, as its body, the browser's TLS bytes from the ClientHello on.
 */
import { z } from 'zod'

export const TUNNEL_LINE_MAX_BYTES = 4096
export const HEADER_CLIENT_IP = 'copse-client-ip'

export const TunnelChallenge = z.strictObject({
  type: z.literal('challenge'),
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})

export const TunnelAuth = z.strictObject({
  type: z.literal('auth'),
  label: z.string().regex(/^[a-z2-7]{12}$/),
  timestampMs: z.number().int(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
})
export type TunnelAuth = z.infer<typeof TunnelAuth>

export const TunnelReady = z.strictObject({ type: z.literal('ready') })

export function tunnelSigningText(label: string, challenge: string, timestampMs: number): string {
  return ['copse-tunnel-v1', label, challenge, String(timestampMs)].join('\n')
}
