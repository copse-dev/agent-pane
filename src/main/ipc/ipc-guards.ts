import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'

export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IpcValidationError'
  }
}

export function assertMainFrameSender(event: IpcMainInvokeEvent, win: BrowserWindow): void {
  if (event.senderFrame !== win.webContents.mainFrame) {
    throw new IpcValidationError('IPC rejected: sender is not the main frame')
  }
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
export const zSessionId = z.string().uuid()

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

export const approvalRespondSchema = z.tuple([
  z.string().uuid(),
  z.boolean(),
  z.boolean().optional(),
])

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
