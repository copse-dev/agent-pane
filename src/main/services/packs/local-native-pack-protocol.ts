import { z } from 'zod'
import { zLocalNativeCapability } from './local-native-pack.ts'

const zRequestId = z.number().int().positive()
const zRegistrationId = z.string().min(1).max(128)

export const zLocalNativeToolRegistration = z.strictObject({
  name: zRegistrationId,
  description: z.string().min(1).max(8_192),
  inputSchema: z.record(z.string(), z.unknown()),
})

export const zLocalNativeRegistrations = z.strictObject({
  tools: z.array(zLocalNativeToolRegistration).max(1_000),
})

export type LocalNativeToolRegistration = z.infer<typeof zLocalNativeToolRegistration>
export type LocalNativeRegistrations = z.infer<typeof zLocalNativeRegistrations>

export const zLocalNativeHostRequest = z.discriminatedUnion('op', [
  z.strictObject({
    id: zRequestId,
    op: z.literal('initialize'),
    packId: z.string().min(1).max(128),
    entrypoint: z.string().min(1).max(10_000),
    sdkVersion: z.literal(1),
    capabilities: z.array(zLocalNativeCapability).max(32),
  }),
  z.strictObject({
    id: zRequestId,
    op: z.literal('invoke'),
    kind: z.literal('tool'),
    registrationId: zRegistrationId,
    input: z.unknown(),
  }),
  z.strictObject({
    id: zRequestId,
    op: z.literal('cancel'),
    targetRequestId: zRequestId,
  }),
  z.strictObject({ id: zRequestId, op: z.literal('shutdown') }),
  z.strictObject({
    id: zRequestId,
    op: z.literal('host-call-result'),
    hostCallId: zRequestId,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().max(8_192).optional(),
  }),
])

export type LocalNativeHostRequest = z.infer<typeof zLocalNativeHostRequest>

export const zLocalNativeWorkerMessage = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('response'),
    id: zRequestId,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().max(8_192).optional(),
  }),
  z.strictObject({
    type: z.literal('host-call'),
    id: zRequestId,
    capability: zLocalNativeCapability,
    method: z.string().min(1).max(128),
    args: z.unknown(),
  }),
])

export type LocalNativeWorkerMessage = z.infer<typeof zLocalNativeWorkerMessage>

export const LOCAL_NATIVE_PROTOCOL_MAX_LINE_BYTES = 1024 * 1024
