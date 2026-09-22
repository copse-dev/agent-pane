import { randomUUID } from 'node:crypto'
import type { ThreadExecutionOwner } from '../thread-execution-context.ts'

const DEFAULT_CAPTURE_TTL_MS = 30 * 60_000
const DEFAULT_MAX_CAPTURE_BYTES = 12 * 1024 * 1024
const DEFAULT_MAX_STORE_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_ENTRIES = 64

export interface BrowserCaptureSource {
  kind: 'browser'
  viewId: string
  title: string
  url: string
}

/** Short-lived authority to pixels captured for one thread. */
export interface CaptureHandle {
  id: string
  kind: 'screenshot'
  source: BrowserCaptureSource
  capturedAt: number
  expiresAt: number
  mimeType: 'image/png'
  width: number
  height: number
  sizeBytes: number
}

export interface ResolvedCaptureHandle {
  handle: CaptureHandle
  bytes: Buffer
}

interface StoredCapture {
  owner: ThreadExecutionOwner
  handle: CaptureHandle
  bytes: Buffer
}

export interface BrowserCaptureInput {
  source: BrowserCaptureSource
  capturedAt: number
  width: number
  height: number
  bytes: Uint8Array
}

interface CaptureHandleRegistryOptions {
  ttlMs?: number
  maxCaptureBytes?: number
  maxStoreBytes?: number
  maxEntries?: number
  now?: () => number
  createId?: () => string
}

function sameOwner(left: ThreadExecutionOwner, right: ThreadExecutionOwner): boolean {
  return left.projectId === right.projectId && left.threadId === right.threadId
}

/**
 * Bounded, process-local capture storage.
 *
 * A handle is deliberately not a path: only a record minted here can resolve,
 * and resolution repeats the trusted thread-owner check. Expired handles stop
 * resolving immediately; their pixels are pruned on the next store access and
 * also disappear on eviction or process exit unless a later evidence tool
 * explicitly copies them into the thread store.
 */
export class CaptureHandleRegistry {
  private readonly entries = new Map<string, StoredCapture>()
  private totalBytes = 0
  private readonly ttlMs: number
  private readonly maxCaptureBytes: number
  private readonly maxStoreBytes: number
  private readonly maxEntries: number
  private readonly now: () => number
  private readonly createId: () => string

  constructor(options: CaptureHandleRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_CAPTURE_TTL_MS
    this.maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES
    this.maxStoreBytes = options.maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
  }

  create(owner: ThreadExecutionOwner, input: BrowserCaptureInput): CaptureHandle {
    const sizeBytes = input.bytes.byteLength
    if (sizeBytes === 0) throw new Error('Cannot retain an empty screenshot')
    if (sizeBytes > this.maxCaptureBytes) {
      throw new Error(
        `Screenshot is ${String(sizeBytes)} bytes, over the ${String(this.maxCaptureBytes)} byte capture limit`,
      )
    }
    if (input.width < 1 || input.height < 1) {
      throw new Error('Cannot retain a screenshot without positive dimensions')
    }

    const now = this.now()
    this.pruneExpired(now)
    const id = `capture_${this.createId()}`
    if (this.entries.has(id)) throw new Error('Capture handle ID collision')
    while (
      this.entries.size >= this.maxEntries ||
      this.totalBytes + sizeBytes > this.maxStoreBytes
    ) {
      const oldest = this.entries.keys().next().value
      if (typeof oldest !== 'string') {
        throw new Error('Screenshot cannot fit in the capture store')
      }
      this.remove(oldest)
    }

    const handle: CaptureHandle = {
      id,
      kind: 'screenshot',
      source: { ...input.source },
      capturedAt: input.capturedAt,
      expiresAt: now + this.ttlMs,
      mimeType: 'image/png',
      width: input.width,
      height: input.height,
      sizeBytes,
    }
    const bytes = Buffer.from(input.bytes)
    this.entries.set(handle.id, {
      owner: { ...owner },
      handle,
      bytes,
    })
    this.totalBytes += bytes.byteLength
    return { ...handle, source: { ...handle.source } }
  }

  resolve(id: string, owner: ThreadExecutionOwner): ResolvedCaptureHandle | null {
    this.pruneExpired(this.now())
    const stored = this.entries.get(id)
    if (!stored || !sameOwner(stored.owner, owner)) return null
    return {
      handle: { ...stored.handle, source: { ...stored.handle.source } },
      bytes: Buffer.from(stored.bytes),
    }
  }

  private pruneExpired(now: number): void {
    for (const [id, stored] of this.entries) {
      if (stored.handle.expiresAt <= now) this.remove(id)
    }
  }

  private remove(id: string): void {
    const stored = this.entries.get(id)
    if (!stored) return
    this.entries.delete(id)
    this.totalBytes -= stored.bytes.byteLength
  }
}

const captureHandles = new CaptureHandleRegistry()

export function createBrowserCaptureHandle(
  owner: ThreadExecutionOwner,
  input: BrowserCaptureInput,
): CaptureHandle {
  return captureHandles.create(owner, input)
}

export function resolveCaptureHandle(
  id: string,
  owner: ThreadExecutionOwner,
): ResolvedCaptureHandle | null {
  return captureHandles.resolve(id, owner)
}
