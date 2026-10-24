import { z } from 'zod'

export const clientAccessSchema = z.enum(['read', 'control'])
export type ClientAccess = z.infer<typeof clientAccessSchema>
export const clientLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\u0000-\u001f\u007f]+$/)
