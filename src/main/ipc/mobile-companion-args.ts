import { z } from 'zod'

// The desktop Settings checkbox is the human acknowledgement. A phone browser
// cannot attest certificate trust, and no phone endpoint may grant itself control.
export const mobileDeviceAccessArgsSchema = z
  .tuple([z.uuid(), z.enum(['read', 'control']), z.boolean().optional()])
  .refine(([, access, rootTrusted]) => access !== 'control' || rootTrusted === true, {
    message: 'Confirm that the Copse Local Root is installed and trusted on this phone',
  })

// A pairing that arrived over this Mac's publicly trusted name needs no
// local-root acknowledgement, and only the main process knows how it arrived,
// so `MobilePairing.respond` enforces the control rule rather than this schema.
export const mobilePairingArgsSchema = z.tuple([
  z.enum(['read', 'control', 'deny']),
  z.string().regex(/^\d{6}$/),
  z.uuid(),
  z.boolean().optional(),
])

/** Invites are issued by hand during the beta and pasted into Settings. */
export const mobileInviteSchema = z.string().trim().min(1).max(64)
