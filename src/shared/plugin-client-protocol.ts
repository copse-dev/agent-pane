import { z } from 'zod'

const id = z.string().regex(/^[\w-]{1,128}$/)
export const clientPairSchema = z.strictObject({
  version: z.literal(1),
  label: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[^\u0000-\u001f\u007f]+$/),
})
export const clientDecisionSchema = z.strictObject({
  version: z.literal(1),
  submissionId: z.uuid(),
  sessionId: z.uuid(),
  projectId: id,
  threadId: id,
  requestId: z.uuid(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  approved: z.boolean(),
})
export const clientSnapshotSchema = z.strictObject({
  version: z.literal(1),
  sessionId: z.uuid(),
  sequence: z.number().int().nonnegative(),
  canRespond: z.boolean(),
  requests: z.array(
    z.strictObject({
      projectId: id,
      threadId: id,
      requestId: z.uuid(),
      revision: z.number().int().positive(),
      title: z.string(),
      body: z.string(),
      advice: z.string().optional(),
      footer: z.string().optional(),
    }),
  ),
})
export type ClientSnapshot = z.infer<typeof clientSnapshotSchema>
