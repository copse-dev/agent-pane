import { z } from 'zod'

// The desktop Settings checkbox is the human acknowledgement. A phone browser
// cannot attest certificate trust, and no phone endpoint may grant itself control.
export const mobileDeviceAccessArgsSchema = z
  .tuple([z.uuid(), z.enum(['read', 'control']), z.boolean().optional()])
  .refine(([, access, rootTrusted]) => access !== 'control' || rootTrusted === true, {
    message: 'Confirm that the Copse Local Root is installed and trusted on this phone',
  })

export const mobilePairingArgsSchema = z
  .tuple([
    z.enum(['read', 'control', 'deny']),
    z.string().regex(/^\d{6}$/),
    z.uuid(),
    z.boolean().optional(),
  ])
  .refine(([decision, , , rootTrusted]) => decision !== 'control' || rootTrusted === true, {
    message: 'Confirm that the Copse Local Root is installed and trusted on this phone',
  })
