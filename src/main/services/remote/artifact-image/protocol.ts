/**
 * Versioned line protocol between main, the per-download host and the confined
 * downloader. Every line is bounded before it is JSON-decoded, and image bytes
 * travel as ordered base64 chunks that each side reassembles and verifies on
 * its own: the host does not trust the downloader, and main does not trust the
 * host's relay.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import {
  ARTIFACT_IMAGE_ERROR_CODES,
  ArtifactImageError,
  canonicalDownloadOrigin,
  MAX_ARTIFACT_IMAGE_BYTES,
  type ArtifactImageErrorCode,
} from './policy.ts'
import {
  inspectArtifactImage,
  SUPPORTED_ARTIFACT_IMAGE_MIME_TYPES,
  type ArtifactImageMime,
} from './image-signature.ts'

export const ARTIFACT_IMAGE_PROTOCOL_VERSION = 1
/** Raw bytes per chunk; base64 keeps each frame's payload under 64 KiB. */
export const ARTIFACT_IMAGE_CHUNK_BYTES = 48 * 1024
/** Whole-line bound, checked before JSON decoding. */
export const ARTIFACT_IMAGE_MAX_LINE_BYTES = 80 * 1024

const zRequestId = z.string().regex(/^[a-f0-9]{32}$/u)
const zOrigins = z.array(z.string().min(1).max(256)).min(1).max(8)
const zMime = z.enum(SUPPORTED_ARTIFACT_IMAGE_MIME_TYPES)

/** Main → host: the only input the host accepts. */
export const zHostJob = z
  .object({
    v: z.literal(ARTIFACT_IMAGE_PROTOCOL_VERSION),
    type: z.literal('job'),
    requestId: zRequestId,
    url: z.string().min(1).max(8192),
    approvedOrigins: zOrigins,
  })
  .strict()
export type HostJob = z.infer<typeof zHostJob>

/** Host → downloader. The proxy token authenticates this job to this job's proxy only. */
export const zDownloaderJob = zHostJob
  .extend({ proxyToken: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict()
export type DownloaderJob = z.infer<typeof zDownloaderJob>

const zChunkFrame = z
  .object({
    v: z.literal(ARTIFACT_IMAGE_PROTOCOL_VERSION),
    type: z.literal('chunk'),
    requestId: zRequestId,
    seq: z.number().int().min(0),
    data: z
      .string()
      .min(1)
      .max(Math.ceil(ARTIFACT_IMAGE_CHUNK_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  })
  .strict()
const zDoneFrame = z
  .object({
    v: z.literal(ARTIFACT_IMAGE_PROTOCOL_VERSION),
    type: z.literal('done'),
    requestId: zRequestId,
    mime: zMime,
    bytes: z.number().int().min(1).max(MAX_ARTIFACT_IMAGE_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
const zErrorFrame = z
  .object({
    v: z.literal(ARTIFACT_IMAGE_PROTOCOL_VERSION),
    type: z.literal('error'),
    requestId: zRequestId,
    code: z.enum(ARTIFACT_IMAGE_ERROR_CODES),
    // Logged by main: only a strict canonical origin, never free text.
    origin: z
      .string()
      .max(256)
      .refine((origin) => canonicalDownloadOrigin(origin) === origin)
      .optional(),
  })
  .strict()
export const zImageFrame = z.discriminatedUnion('type', [zChunkFrame, zDoneFrame, zErrorFrame])
export type ImageFrame = z.infer<typeof zImageFrame>

export function encodeFrame(frame: ImageFrame | HostJob | DownloaderJob): string {
  return `${JSON.stringify(frame)}\n`
}

/** Decode one bounded line with `schema`, or null. */
export function decodeLine<T>(
  line: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): T | null {
  if (Buffer.byteLength(line, 'utf8') > ARTIFACT_IMAGE_MAX_LINE_BYTES) return null
  return safeJsonParse(line, decodeWithSchema(schema))
}

/**
 * Split a stream into lines, failing as soon as a pending line would exceed the
 * bound — before a hostile peer can make this side buffer an unbounded line.
 */
export class BoundedLineSplitter {
  private pending = ''
  private readonly onLine: (line: string) => void
  private readonly onOverflow: () => void
  private overflowed = false

  constructor(onLine: (line: string) => void, onOverflow: () => void) {
    this.onLine = onLine
    this.onOverflow = onOverflow
  }

  push(chunk: string): void {
    if (this.overflowed) return
    this.pending += chunk
    let newline = this.pending.indexOf('\n')
    while (newline !== -1) {
      const line = this.pending.slice(0, newline)
      this.pending = this.pending.slice(newline + 1)
      this.onLine(line)
      newline = this.pending.indexOf('\n')
    }
    if (this.pending.length > ARTIFACT_IMAGE_MAX_LINE_BYTES) {
      this.overflowed = true
      this.pending = ''
      this.onOverflow()
    }
  }
}

export interface VerifiedArtifactImage {
  mime: ArtifactImageMime
  bytes: Buffer
}

/**
 * Reassemble one job's frames and verify them independently of the sender:
 * request identity, contiguous sequence, aggregate size, a single completion
 * whose length and digest match what arrived, and an image signature matching
 * the declared type. Any violation is terminal; partial output is discarded.
 */
export class ImageFrameAssembler {
  private readonly requestId: string
  private readonly chunks: Buffer[] = []
  private received = 0
  private nextSeq = 0
  /** A short chunk can only be the last one; this bounds the frame count. */
  private sawShortChunk = false
  private state: 'open' | 'done' | 'failed' = 'open'

  constructor(requestId: string) {
    this.requestId = requestId
  }

  /** Feed one decoded frame. Returns the finished image on `done`, else null. */
  accept(frame: ImageFrame): VerifiedArtifactImage | null {
    if (this.state !== 'open') throw this.fail('protocol')
    if (frame.requestId !== this.requestId) throw this.fail('protocol')
    switch (frame.type) {
      case 'chunk': {
        if (frame.seq !== this.nextSeq) throw this.fail('protocol')
        const data = Buffer.from(frame.data, 'base64')
        if (data.length === 0 || data.length > ARTIFACT_IMAGE_CHUNK_BYTES || this.sawShortChunk) {
          throw this.fail('protocol')
        }
        if (data.length < ARTIFACT_IMAGE_CHUNK_BYTES) this.sawShortChunk = true
        this.received += data.length
        if (this.received > MAX_ARTIFACT_IMAGE_BYTES) throw this.fail('too-large')
        this.chunks.push(data)
        this.nextSeq++
        return null
      }
      case 'done': {
        const bytes = Buffer.concat(this.chunks)
        this.chunks.length = 0
        if (bytes.length !== frame.bytes) throw this.fail('protocol')
        if (createHash('sha256').update(bytes).digest('hex') !== frame.sha256) {
          throw this.fail('protocol')
        }
        const inspection = inspectArtifactImage(bytes, frame.mime)
        if (!inspection.ok) {
          throw this.fail(inspection.reason === 'type' ? 'bad-type' : 'bad-image')
        }
        this.state = 'done'
        return { mime: frame.mime, bytes }
      }
      case 'error':
        throw this.fail(frame.code, frame.origin)
    }
  }

  private fail(code: ArtifactImageErrorCode, detail?: string): ArtifactImageError {
    this.state = 'failed'
    this.chunks.length = 0
    return new ArtifactImageError(code, detail)
  }
}

/** Split verified bytes back into frames (the downloader's and host's output side). */
export function imageFrames(
  requestId: string,
  mime: ArtifactImageMime,
  bytes: Buffer,
): ImageFrame[] {
  const frames: ImageFrame[] = []
  let seq = 0
  for (let offset = 0; offset < bytes.length; offset += ARTIFACT_IMAGE_CHUNK_BYTES) {
    frames.push({
      v: ARTIFACT_IMAGE_PROTOCOL_VERSION,
      type: 'chunk',
      requestId,
      seq: seq++,
      data: bytes.subarray(offset, offset + ARTIFACT_IMAGE_CHUNK_BYTES).toString('base64'),
    })
  }
  frames.push({
    v: ARTIFACT_IMAGE_PROTOCOL_VERSION,
    type: 'done',
    requestId,
    mime,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
  return frames
}

export function errorFrame(
  requestId: string,
  code: ArtifactImageErrorCode,
  origin?: string,
): ImageFrame {
  return {
    v: ARTIFACT_IMAGE_PROTOCOL_VERSION,
    type: 'error',
    requestId,
    code,
    // Anything but a canonical origin is dropped rather than relayed.
    ...(origin && canonicalDownloadOrigin(origin) === origin ? { origin } : {}),
  }
}
