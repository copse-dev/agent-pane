import { z } from 'zod'

/** Human steering receipts are evidence, never an automatic resume queue. */
export const userSteeringReceiptSchema = z.object({
  messageId: z.string().min(1),
  runId: z.string().min(1),
  epoch: z.string().min(1),
  at: z.number().int().nonnegative(),
  state: z.enum(['accepted', 'applied', 'held']),
})

export type UserSteeringReceipt = z.infer<typeof userSteeringReceiptSchema>
