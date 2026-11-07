import { z } from 'zod'

const scope = z.string().regex(/^[\w-]{1,128}$/)
export const clientActionSchema = z.strictObject({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(500),
  kind: z.enum(['next-step', 'follow-up']),
})
export const clientActionOfferSchema = z.strictObject({
  projectId: scope,
  threadId: scope,
  revision: z.uuid(),
  actions: z.array(clientActionSchema).max(8),
})
export const clientActionReferenceSchema = clientActionOfferSchema
  .omit({ actions: true })
  .extend({ actionId: clientActionSchema.shape.id })
export const clientActionSubmissionSchema = clientActionReferenceSchema.extend({
  version: z.literal(1),
  sessionId: z.uuid(),
  submissionId: z.uuid(),
})
export const clientActionSnapshotSchema = z.strictObject({
  version: z.literal(1),
  sessionId: z.uuid(),
  offer: clientActionOfferSchema.nullable(),
})
export type ClientActionOffer = z.infer<typeof clientActionOfferSchema>
export type ClientActionReference = z.infer<typeof clientActionReferenceSchema>
export interface ClientActionCommand extends ClientActionReference {
  id: string
  expiresAt: number
}
