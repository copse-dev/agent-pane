import { z } from 'zod'

const zRequestId = z.number().int().positive()
const zRegistrationId = z.string().min(1).max(128)

export const zPluginToolRegistration = z.strictObject({
  name: zRegistrationId,
  description: z.string().min(1).max(8_192),
  inputSchema: z.record(z.string(), z.unknown()),
})

export const zPluginModelRegistration = z.strictObject({ id: zRegistrationId })

export const zPluginModelAttachment = z.strictObject({
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  dataBase64: z
    .string()
    .min(1)
    .max(12 * 1024 * 1024),
})

export const zPluginModelHistoryMessage = z.strictObject({
  role: z.enum(['user', 'assistant', 'tool']),
  text: z.string().max(64 * 1024),
})

export const zPluginModelTurn = z.strictObject({
  threadId: z.string().min(1).max(256),
  prompt: z.string().max(256 * 1024),
  attachments: z.array(zPluginModelAttachment).max(8),
  history: z.array(zPluginModelHistoryMessage).max(64),
})

export const zPluginBrowserTab = z.strictObject({
  tabId: z.string().min(1).max(128),
  title: z.string().max(2_048),
  url: z.string().max(16_384),
  active: z.boolean(),
})

export const zPluginBrowserUploadFile = z.strictObject({
  name: z.string().min(1).max(256),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  dataBase64: z
    .string()
    .min(1)
    .max(12 * 1024 * 1024),
})

const zPluginBrowserCallBase = {
  type: z.literal('browser-call'),
  id: zRequestId,
  invocationId: zRequestId,
}

export const zPluginBrowserCall = z.discriminatedUnion('op', [
  z.strictObject({
    ...zPluginBrowserCallBase,
    op: z.literal('open'),
    url: z.string().min(1).max(16_384),
    newTab: z.boolean().optional(),
  }),
  z.strictObject({
    ...zPluginBrowserCallBase,
    op: z.literal('navigate'),
    tabId: z.string().min(1).max(128),
    url: z.string().min(1).max(16_384),
  }),
  z.strictObject({ ...zPluginBrowserCallBase, op: z.literal('tabs') }),
  z.strictObject({
    ...zPluginBrowserCallBase,
    op: z.literal('snapshot'),
    tabId: z.string().min(1).max(128),
  }),
  z.strictObject({
    ...zPluginBrowserCallBase,
    op: z.literal('click'),
    tabId: z.string().min(1).max(128),
    ref: z.string().min(1).max(128),
  }),
  z.strictObject({
    ...zPluginBrowserCallBase,
    op: z.literal('type'),
    tabId: z.string().min(1).max(128),
    ref: z.string().min(1).max(128),
    text: z.string().max(256 * 1024),
  }),
  z.strictObject({
    ...zPluginBrowserCallBase,
    op: z.literal('upload'),
    tabId: z.string().min(1).max(128),
    ref: z.string().min(1).max(128),
    files: z.array(zPluginBrowserUploadFile).min(1).max(8),
  }),
])

export const zPluginToolRegistrations = z.strictObject({
  tools: z.array(zPluginToolRegistration).max(1_000),
  models: z.array(zPluginModelRegistration).max(1_000),
})

export type PluginToolRegistration = z.infer<typeof zPluginToolRegistration>
export type PluginModelRegistration = z.infer<typeof zPluginModelRegistration>
export type PluginModelAttachment = z.infer<typeof zPluginModelAttachment>
export type PluginModelHistoryMessage = z.infer<typeof zPluginModelHistoryMessage>
export type PluginModelTurn = z.infer<typeof zPluginModelTurn>
export type PluginBrowserTab = z.infer<typeof zPluginBrowserTab>
export type PluginBrowserUploadFile = z.infer<typeof zPluginBrowserUploadFile>
export type PluginBrowserCall = z.infer<typeof zPluginBrowserCall>
export type PluginToolRegistrations = z.infer<typeof zPluginToolRegistrations>

export const zPluginToolHostRequest = z.discriminatedUnion('op', [
  z.strictObject({
    id: zRequestId,
    op: z.literal('initialize'),
    pluginId: z.string().min(1).max(128),
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

export type PluginToolHostRequest = z.infer<typeof zPluginToolHostRequest>

export const zPluginToolWorkerMessage = z.union([
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
  zPluginBrowserCall,
])

export type PluginToolWorkerMessage = z.infer<typeof zPluginToolWorkerMessage>

// A bounded image attachment crosses as base64 in one NDJSON request. Eight
// decoded attachments are capped separately before this transport ceiling.
export const PLUGIN_TOOL_PROTOCOL_MAX_LINE_BYTES = 16 * 1024 * 1024
