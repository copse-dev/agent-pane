import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { isTrustedAppFrame } from '../windows/app-frames.ts'
import type { VncDiscoveryHost, VncTarget } from '@shared/types/vnc.ts'

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

const zPortNumber = z.number().int().min(1).max(65535)

export const vncTargetSchema: z.ZodType<VncTarget> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('loopback'), port: zPortNumber }),
  z.object({
    kind: z.literal('ssh'),
    hostId: z.string().regex(/^[\w.-]{1,128}$/),
    remotePort: zPortNumber,
    display: z.string().max(128).optional(),
  }),
  z.object({
    kind: z.literal('network'),
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[\w.:%-]+$/),
    port: zPortNumber,
    confirmedUnencrypted: z.literal(true),
  }),
])

export const vncDiscoveryHostSchema: z.ZodType<VncDiscoveryHost> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }),
  z.object({ kind: z.literal('ssh'), hostId: z.string().regex(/^[\w.-]{1,128}$/) }),
])

/** Decode the single positional argument accepted by `ports:kill`. */
export function parsePortKillArgs(args: unknown[]): number {
  return parseIpcArgs(zPortNumber, args)
}

export const zNonEmptyString = z.string().min(1)
export const zPathString = z.string().max(4096)
export const zSessionId = z.uuid()

// Thread ids name on-disk directories and historically composed electron-store
// keys (`llm-history:${threadId}`); keep them charset/length-safe to avoid
// path/key injection.
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
  model: z.string().optional(),
})

export const comparisonModelSelectionSchema = z.object({
  a: z.string().min(1).max(500),
  b: z.string().min(1).max(500),
  judge: z.string().min(1).max(500),
})

export const retryReviewPayloadSchema = z.object({
  workingBrief: z.string().max(8192).optional(),
  model: z.string().max(256).optional(),
  /**
   * Reviewer/judge models chosen in the "Compare models" bubble's picker. Read
   * only by the comparison path, where their presence also means the picker
   * already served as the spend decision — so the shape is pinned here rather
   * than trusted, keeping the models a renderer can name to well-formed ids.
   */
  comparisonModels: comparisonModelSelectionSchema.optional(),
})

export const followUpContextSchema = z.object({
  userMessage: z.string(),
  assistantMessage: z.string(),
  toolNames: z.array(z.string()),
})

/**
 * `hooks:test` request (G2 dry-run tester). The renderer echoes back a
 * discovered hook's identity from Sources; validate it so a compromised
 * renderer cannot smuggle an arbitrary command through the dry-run spawn — the
 * command is still one that hook discovery surfaced, but the shape is pinned.
 */
export const zHookTestRequest = z.object({
  family: z.enum(['cursor', 'claude', 'copse']),
  event: z.string().min(1).max(256),
  command: z.string().min(1).max(8192),
  source: z.string().max(4096),
  scope: z.enum(['user', 'project']),
  sandbox: z.boolean().optional(),
})

/**
 * A spine `hook_run` id (`hooks:runDetail`). Recorded ids are UUIDs, but seeded
 * fixtures and older records use plain slugs — pin the character class rather
 * than the UUID shape, which is enough to keep an id from becoming a path.
 */
export const zHookRunId = z.string().regex(/^[\w-]{1,128}$/)

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

const STORAGE_KEY = z.union([z.literal('projects'), z.literal('activeProjectId')])

export const zProjectId = z.string().regex(/^[\w-]{1,128}$/)

const imageDataUrlSchema = z
  .string()
  .max(12 * 1024 * 1024)
  .regex(/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/)

export const describeImagesSchema = z.tuple([
  zProjectId,
  zThreadId,
  z.string().min(1).max(500),
  z.string().max(1_000_000),
  z.array(imageDataUrlSchema).min(1).max(5),
])

export function assertStorageKey(key: string): void {
  const parsed = STORAGE_KEY.safeParse(key)
  if (!parsed.success) {
    throw new IpcValidationError('Storage key not allowed')
  }
}

export const approvalRespondSchema = z.tuple([
  z.uuid(),
  z.boolean(),
  z.boolean().optional(),
  comparisonModelSelectionSchema.optional(),
  z.enum(['once', 'turn-tree']).optional(),
])

// Answer payload for a pending ask_user question: the request id plus one answer
// string per question, in order. Answers are bounded so a runaway/hostile
// renderer can't feed an unbounded blob back into the agent's context.
export const askRespondSchema = z.tuple([z.uuid(), z.array(z.string().max(8192)).max(10)])

// Third element: keep the secret in memory for this app session. Always sent by
// preload so the tuple stays fixed-arity.
export const sshPromptRespondSchema = z.tuple([z.uuid(), z.string().max(8192), z.boolean()])

export const updatePromptRespondSchema = z.tuple([z.uuid(), z.number().int().min(-1).max(10)])

// The renderer's verdict on a close/quit it was asked to confirm: `true` lets
// the app go down, `false` keeps it up.
export const closeConfirmRespondSchema = z.tuple([z.uuid(), z.boolean()])

export const zSshHostId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)

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

// Model ids to resolve card links for. Bounded because the renderer batches a
// whole chart's worth, and each unknown id can cost a network probe.
export const modelCardIdsSchema = z.array(z.string().min(1).max(512)).max(128)

// Per-save consent for storing a key unencrypted when OS secure storage is
// unavailable. Defaults to no consent so the plaintext write is always opt-in.
export const setKeyOptionsSchema = z
  .object({ allowPlaintext: z.boolean().optional() })
  .optional()
  .transform((v) => ({ allowPlaintext: v?.allowPlaintext === true }))
