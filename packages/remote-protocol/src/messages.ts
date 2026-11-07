/** Request and response bodies for the names API (device endpoints and the shell). */
import { z } from 'zod'

import { DevicePublicKey } from './keys.ts'

const Label = z.string().regex(/^[a-z2-7]{12}$/)

// Device endpoints ------------------------------------------------------------------------------

export const RegisterRequest = z.strictObject({
  publicKey: DevicePublicKey,
  invite: z.string().min(1).max(64),
})
export type RegisterRequest = z.infer<typeof RegisterRequest>

export const RegisterResponse = z.strictObject({
  label: Label,
  hostnames: z.strictObject({ lan: z.string(), web: z.string() }),
})
export type RegisterResponse = z.infer<typeof RegisterResponse>

export const AddressRequest = z.strictObject({ address: z.string().max(64) })
export type AddressRequest = z.infer<typeof AddressRequest>

export const CertificateRequest = z.strictObject({
  /** PKCS#10 CSR, DER encoded, base64url. */
  csr: z.string().min(1).max(8192),
})
export type CertificateRequest = z.infer<typeof CertificateRequest>

export const RenewalWindow = z.strictObject({ start: z.string(), end: z.string() })

export const CertificateResponse = z.strictObject({
  /** Leaf first, PEM. */
  chain: z.string(),
  notAfter: z.string(),
  renewalWindow: RenewalWindow.nullable(),
})
export type CertificateResponse = z.infer<typeof CertificateResponse>

export const DeviceStatusResponse = z.strictObject({
  label: Label,
  state: z.enum(['active', 'dormant', 'retired']),
  lanAddress: z.string().nullable(),
  lastRenewedAt: z.string(),
  certificate: z
    .strictObject({ notAfter: z.string(), renewalWindow: RenewalWindow.nullable() })
    .nullable(),
})
export type DeviceStatusResponse = z.infer<typeof DeviceStatusResponse>

export const ErrorResponse = z.strictObject({ error: z.string(), message: z.string() })
export type ErrorResponse = z.infer<typeof ErrorResponse>

// Shell endpoints --------------------------------------------------------------------------------

/** A label grant as carried by the pairing QR code; see `grant.ts`. */
export const LabelGrant = z.strictObject({
  v: z.literal(1),
  label: Label,
  id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  expiresMs: z.number().int().positive(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
})
export type LabelGrant = z.infer<typeof LabelGrant>

export const AddDeviceRequest = z.strictObject({ grant: LabelGrant })

export const WebAuthnFinishRequest = z.strictObject({
  flowId: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/),
  // The WebAuthn response is validated field by field by the verifier.
  response: z.record(z.string(), z.unknown()),
})

export const PushSubscriptionRequest = z.strictObject({
  endpoint: z.url({ protocol: /^https$/ }).max(1024),
})
