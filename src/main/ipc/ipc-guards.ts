import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { isTrustedAppFrame } from '../windows/app-frames.ts'

export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IpcValidationError'
  }
}

export function assertMainFrameSender(event: IpcMainInvokeEvent, win: BrowserWindow): void {
  const frame = event.senderFrame
  // The main window's own main frame, or a pane pop-out window we created. Both
  // load our renderer; sub-frames and <webview> guests are still rejected.
  if (frame === win.webContents.mainFrame) return
  if (isTrustedAppFrame(frame)) return
  throw new IpcValidationError('IPC rejected: sender is not the main frame')
}

export function parseIpcArgs<T extends z.ZodType>(schema: T, args: unknown[]): z.infer<T> {
  const parsed = schema.safeParse(args.length === 1 ? args[0] : args)
  if (!parsed.success) {
    throw new IpcValidationError(parsed.error.message)
  }
  return parsed.data
}

export const zNonEmptyString = z.string().min(1)
export const zPathString = z.string().max(4096)
export const zSessionId = z.uuid()

// Thread ids compose a persisted storage key (`llm-history:${threadId}`), so they
// must be restricted to a safe charset/length to avoid key-injection.
export const zThreadId = z.string().regex(/^[\w-]{1,128}$/)

// An outbound URL the main process will fetch (e.g. a local LM Studio server).
// Restrict to http(s) to deny file:/other schemes used as an SSRF/exfil sink.
export const zHttpUrl = z
  .url()
  .max(2048)
  .refine((u) => u.startsWith('http://') || u.startsWith('https://'), {
    message: 'URL must be http or https',
  })

// Optional provider API key — bounded so a malformed/oversized value is rejected
// before it reaches the outbound request.
export const zOptionalApiKey = z.string().max(4096).optional()

// LM Studio model identifier — a bounded non-empty string.
export const zModelId = z.string().min(1).max(256)

// MCP server name — a bounded non-empty string.
export const zMcpServerName = z.string().min(1).max(256)

export const lmStudioTestSchema = z.tuple([zHttpUrl, zOptionalApiKey])
export const lmStudioDetectSchema = z.tuple([zHttpUrl.optional(), zOptionalApiKey])
export const lmStudioDownloadSchema = z.tuple([zModelId, zHttpUrl.optional(), zOptionalApiKey])
export const lmStudioDownloadStatusSchema = z.tuple([
  z.string().min(1).max(256),
  zHttpUrl.optional(),
  zOptionalApiKey,
])

export const estimateContextPayloadSchema = z.object({
  draftText: z.string().optional(),
  invokedSkills: z.array(z.string()).optional(),
  imageCount: z.number().optional(),
})

export const followUpContextSchema = z.object({
  userMessage: z.string(),
  assistantMessage: z.string(),
  toolNames: z.array(z.string()),
})

export const INDEX_QUERY_PATTERN = /^[\w.\-/+$@ ]{0,128}$/

export function isIndexQueryPattern(pattern: string): boolean {
  return INDEX_QUERY_PATTERN.test(pattern)
}

export const MAX_FS_WRITE_BYTES = 16 * 1024 * 1024

export function assertFsWriteContent(content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_FS_WRITE_BYTES) {
    throw new IpcValidationError('File content exceeds size limit')
  }
}

const STORAGE_KEY = z.union([
  z.literal('projects'),
  z.literal('activeProjectId'),
  z.string().regex(/^threads:[\w-]{1,128}$/),
])

export function assertStorageKey(key: string): void {
  const parsed = STORAGE_KEY.safeParse(key)
  if (!parsed.success) {
    throw new IpcValidationError('Storage key not allowed')
  }
}

export const approvalRespondSchema = z.tuple([z.uuid(), z.boolean(), z.boolean().optional()])

export const providerSchema = z.enum([
  'anthropic',
  'openai',
  'lmstudio',
  'cursor',
  'openrouter',
  'mistral',
  'gemini',
  'deepseek',
])

// Cloud providers the renderer can query availability for and validate keys
// against (everything in `providerSchema` except the local LM Studio server).
export const cloudProviderSchema = z.enum([
  'anthropic',
  'openai',
  'cursor',
  'openrouter',
  'mistral',
  'gemini',
  'deepseek',
])

// Any provider key slug: the fixed providers above plus arbitrary user-added
// custom-provider slugs (URL-safe, derived from a base-URL hostname).
export const keyProviderSchema = z.string().regex(/^[a-z0-9-]{1,64}$/)
