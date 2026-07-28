import { z } from 'zod'

const zRequestId = z.number().int().positive()
const zRegistrationId = z.string().min(1).max(128)

export const zPackToolRegistration = z.strictObject({
  name: zRegistrationId,
  description: z.string().min(1).max(8_192),
  inputSchema: z.record(z.string(), z.unknown()),
})

export const zPackModelRegistration = z.strictObject({ id: zRegistrationId })

export const zPackModelAttachment = z.strictObject({
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  dataBase64: z
    .string()
    .min(1)
    .max(12 * 1024 * 1024),
})

export const zPackModelHistoryMessage = z.strictObject({
  role: z.enum(['user', 'assistant', 'tool']),
  text: z.string().max(64 * 1024),
})

export const zPackModelTurn = z.strictObject({
  threadId: z.string().min(1).max(256),
  prompt: z.string().max(256 * 1024),
  attachments: z.array(zPackModelAttachment).max(8),
  history: z.array(zPackModelHistoryMessage).max(64),
})

export const zPackBrowserTab = z.strictObject({
  tabId: z.string().min(1).max(128),
  title: z.string().max(2_048),
  url: z.string().max(16_384),
  active: z.boolean(),
})

export const zPackBrowserUploadFile = z.strictObject({
  name: z.string().min(1).max(256),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  dataBase64: z
    .string()
    .min(1)
    .max(12 * 1024 * 1024),
})

const zPackBrowserCallBase = {
  type: z.literal('browser-call'),
  id: zRequestId,
  invocationId: zRequestId,
}

export const zPackBrowserCall = z.discriminatedUnion('op', [
  z.strictObject({
    ...zPackBrowserCallBase,
    op: z.literal('open'),
    url: z.string().min(1).max(16_384),
    newTab: z.boolean().optional(),
  }),
  z.strictObject({
    ...zPackBrowserCallBase,
    op: z.literal('navigate'),
    tabId: z.string().min(1).max(128),
    url: z.string().min(1).max(16_384),
  }),
  z.strictObject({ ...zPackBrowserCallBase, op: z.literal('tabs') }),
  z.strictObject({
    ...zPackBrowserCallBase,
    op: z.literal('snapshot'),
    tabId: z.string().min(1).max(128),
  }),
  z.strictObject({
    ...zPackBrowserCallBase,
    op: z.literal('click'),
    tabId: z.string().min(1).max(128),
    ref: z.string().min(1).max(128),
  }),
  z.strictObject({
    ...zPackBrowserCallBase,
    op: z.literal('type'),
    tabId: z.string().min(1).max(128),
    ref: z.string().min(1).max(128),
    text: z.string().max(256 * 1024),
  }),
  z.strictObject({
    ...zPackBrowserCallBase,
    op: z.literal('upload'),
    tabId: z.string().min(1).max(128),
    ref: z.string().min(1).max(128),
    files: z.array(zPackBrowserUploadFile).min(1).max(8),
  }),
])

export const zPackToolRegistrations = z.strictObject({
  tools: z.array(zPackToolRegistration).max(1_000),
  models: z.array(zPackModelRegistration).max(1_000),
})

export type PackToolRegistration = z.infer<typeof zPackToolRegistration>
export type PackModelRegistration = z.infer<typeof zPackModelRegistration>
export type PackModelAttachment = z.infer<typeof zPackModelAttachment>
export type PackModelHistoryMessage = z.infer<typeof zPackModelHistoryMessage>
export type PackModelTurn = z.infer<typeof zPackModelTurn>
export type PackBrowserTab = z.infer<typeof zPackBrowserTab>
export type PackBrowserUploadFile = z.infer<typeof zPackBrowserUploadFile>
export type PackBrowserCall = z.infer<typeof zPackBrowserCall>
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
    kind: z.enum(['tool', 'model']),
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
    op: z.literal('session-result'),
    sessionRequestId: zRequestId,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().max(8_192).optional(),
  }),
  z.strictObject({
    id: zRequestId,
    op: z.literal('browser-result'),
    browserRequestId: zRequestId,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().max(8_192).optional(),
  }),
])

export type PackToolHostRequest = z.infer<typeof zPackToolHostRequest>

export const zPackToolWorkerMessage = z.union([
  z.strictObject({
    type: z.literal('response'),
    id: zRequestId,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().max(8_192).optional(),
  }),
  z.strictObject({
    type: z.literal('session-call'),
    id: zRequestId,
    invocationId: zRequestId,
    op: z.enum(['get', 'set', 'delete']),
    state: z.unknown().optional(),
  }),
  zPackBrowserCall,
])

export type PackToolWorkerMessage = z.infer<typeof zPackToolWorkerMessage>

// A bounded image attachment crosses as base64 in one NDJSON request. Eight
// decoded attachments are capped separately before this transport ceiling.
export const PACK_TOOL_PROTOCOL_MAX_LINE_BYTES = 16 * 1024 * 1024
