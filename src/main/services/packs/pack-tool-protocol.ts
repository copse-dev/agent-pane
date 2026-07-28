import { z } from 'zod'

const zRequestId = z.number().int().positive()
const zRegistrationId = z.string().min(1).max(128)

export const zPackToolRegistration = z.strictObject({
  name: zRegistrationId,
  description: z.string().min(1).max(8_192),
  inputSchema: z.record(z.string(), z.unknown()),
})

export const zPackToolRegistrations = z.strictObject({
  tools: z.array(zPackToolRegistration).max(1_000),
})

export type PackToolRegistration = z.infer<typeof zPackToolRegistration>
export type PackToolRegistrations = z.infer<typeof zPackToolRegistrations>

export const zPackToolHostRequest = z.discriminatedUnion('op', [
  z.strictObject({
    id: zRequestId,
    op: z.literal('initialize'),
    packId: z.string().min(1).max(128),
    entrypoint: z.string().min(1).max(10_000),
    apiVersion: z.literal(1),
  }),
  z.strictObject({
    id: zRequestId,
    op: z.literal('invoke'),
    registrationId: zRegistrationId,
    input: z.unknown(),
  }),
  z.strictObject({
    id: zRequestId,
    op: z.literal('cancel'),
    targetRequestId: zRequestId,
  }),
  z.strictObject({ id: zRequestId, op: z.literal('shutdown') }),
])

export type PackToolHostRequest = z.infer<typeof zPackToolHostRequest>

export const zPackToolWorkerMessage = z.strictObject({
  type: z.literal('response'),
  id: zRequestId,
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().max(8_192).optional(),
})

export type PackToolWorkerMessage = z.infer<typeof zPackToolWorkerMessage>

export const PACK_TOOL_PROTOCOL_MAX_LINE_BYTES = 1024 * 1024
