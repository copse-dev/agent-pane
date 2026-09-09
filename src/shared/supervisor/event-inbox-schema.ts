import { z } from 'zod'
import { permissionSnapshotSchema } from './task-schema.ts'

const identity = z.string().min(1).max(256)
const localId = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)

/** A host-owned projection of a saved definition, not a new user configuration format. */
export const eventAutomationBindingSchema = z.strictObject({
  automationId: identity,
  definitionRevision: identity,
  definitionHash: sha256,
  projectId: localId,
  sourceId: identity,
  connectionId: identity,
  eventType: identity,
  eventVersion: z.literal(1),
  repositoryId: identity,
  workflowId: identity,
  profileId: identity,
  permissionSnapshot: permissionSnapshotSchema,
})
export type EventAutomationBinding = z.infer<typeof eventAutomationBindingSchema>

/** Normalized, redacted source evidence. Unknown instruction/grant fields are rejected. */
export const automationDeliverySchema = z.strictObject({
  sourceId: identity,
  connectionId: identity,
  deliveryId: z.string().min(1).max(1024),
  eventType: identity,
  eventVersion: z.literal(1),
  projectId: localId,
  repositoryId: identity,
  resourceId: identity,
  resourceRevision: identity,
  occurredAt: z.number().int().nonnegative(),
  originAutomationId: identity.optional(),
  facts: z
    .record(
      z.string().min(1).max(128),
      z.union([z.string().max(1024), z.number(), z.boolean(), z.null()]),
    )
    .refine((facts) => Object.keys(facts).length <= 32, 'Too many event facts')
    .transform((facts) =>
      Object.fromEntries(Object.entries(facts).sort(([a], [b]) => a.localeCompare(b))),
    ),
  payload: z
    .string()
    .max(65_536)
    .refine(
      (payload) => new TextEncoder().encode(payload).byteLength <= 65_536,
      'Event payload exceeds 64 KiB',
    ),
})
export type AutomationDelivery = z.infer<typeof automationDeliverySchema>

export const eventInboxRecordSchema = z
  .strictObject({
    v: z.literal(1),
    key: sha256,
    binding: eventAutomationBindingSchema,
    delivery: automationDeliverySchema,
    payloadSha256: sha256,
    receivedAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    state: z.enum(['admitted', 'claimed', 'queued', 'prepared', 'filtered', 'fenced']),
    runId: localId.optional(),
    reason: z.string().min(1).max(512).optional(),
  })
  .superRefine((record, ctx) => {
    if (['claimed', 'queued', 'prepared'].includes(record.state) && !record.runId) {
      ctx.addIssue({ code: 'custom', message: 'Claimed deliveries require a run identity' })
    }
    if (['filtered', 'fenced'].includes(record.state) && !record.reason) {
      ctx.addIssue({ code: 'custom', message: 'Held deliveries require an explanation' })
    }
  })
export type EventInboxRecord = z.infer<typeof eventInboxRecordSchema>
