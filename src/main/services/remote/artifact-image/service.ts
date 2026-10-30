/**
 * Main-process side of automatic remote-artifact image hydration
 * (docs/plans/sandboxed-artifact-image-downloads.md).
 *
 * Main authorizes the request against durable thread provenance, makes the one
 * credentialed metadata request, checks the signed URL against the provider's
 * download origins, and hands the download to a short-lived confined host. It
 * never fetches image bytes itself, and nothing falls back to doing so.
 */
import { createHmac, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { RemoteAgentLink } from '@shared/remote-agent-link.ts'
import type { RemoteArtifactImageResult } from '@shared/remote-artifact-image.ts'
import { LruStringCache } from '../lru-string-cache.ts'
import {
  ArtifactImageError,
  checkDownloadUrl,
  CURSOR_ARTIFACT_DOWNLOAD_ORIGINS,
  isRetryableArtifactImageError,
  validateArtifactPath,
} from './policy.ts'
import {
  ARTIFACT_IMAGE_PROTOCOL_VERSION,
  ImageFrameAssembler,
  type HostJob,
  type ImageFrame,
  type VerifiedArtifactImage,
} from './protocol.ts'

const MAX_CONCURRENT_JOBS = 2
const MAX_QUEUED_JOBS = 16
const CACHE_ENTRIES = 64
const CACHE_BYTES = 64 * 1024 * 1024

/** The renderer's request. Identity comes from the thread, never from transcript text. */
export const zArtifactImageRequest = z
  .object({
    projectId: z.string().min(1).max(256),
    threadId: z.string().min(1).max(256),
    path: z.string().min(1).max(4096),
    agentId: z.string().min(1).max(128).optional(),
  })
  .strict()
export type ArtifactImageRequest = z.infer<typeof zArtifactImageRequest>

export type ArtifactImageResult = RemoteArtifactImageResult

export interface ArtifactImageServiceDependencies {
  /** The thread's durable remote-agent link; throws for an unknown or invalid thread. */
  readThreadLink(projectId: string, threadId: string): Promise<RemoteAgentLink | null>
  /** Configured provider API base and key; throws when not configured. */
  credentials(): { baseUrl: string; apiKey: string }
  resolveDownloadUrl(input: {
    baseUrl: string
    apiKey: string
    agentId: string
    path: string
    signal: AbortSignal
  }): Promise<string>
  /** Whether this platform has an ASRT backend to confine the download with. */
  sandboxPlatform(): boolean
  /** Run one job in a fresh confined host, delivering each frame it emits. */
  runHost(job: HostJob, onFrame: (frame: ImageFrame) => void, signal: AbortSignal): Promise<void>
  newRequestId?(): string
  log?(line: string): void
}

interface Job {
  key: string
  threadKey: string
  run: () => Promise<string>
  resolve: (dataUrl: string) => void
  reject: (error: unknown) => void
}

/** Process-local key so a credential's cache identity reveals nothing about it. */
const CREDENTIAL_KEY = randomBytes(32)

function credentialGeneration(apiKey: string): string {
  return createHmac('sha256', CREDENTIAL_KEY).update(apiKey).digest('hex').slice(0, 32)
}

function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin
  } catch {
    return baseUrl
  }
}

export class ArtifactImageService {
  private readonly dependencies: ArtifactImageServiceDependencies
  private readonly cache = new LruStringCache(CACHE_ENTRIES, CACHE_BYTES)
  private readonly inFlight = new Map<string, Promise<string>>()
  private readonly queue: Job[] = []
  private readonly activeThreads = new Set<string>()
  private active = 0
  /** Bumped by {@link invalidate}; an older in-flight result may not repopulate the cache. */
  private generation = 0

  constructor(dependencies: ArtifactImageServiceDependencies) {
    this.dependencies = dependencies
  }

  /** Drop every cached image and stop in-flight work from repopulating the cache. */
  invalidate(): void {
    this.generation++
    this.cache.clear()
  }

  async load(request: ArtifactImageRequest): Promise<ArtifactImageResult> {
    const started = Date.now()
    try {
      const dataUrl = await this.authorizeAndLoad(request)
      this.log(`ok ms=${String(Date.now() - started)} bytes=${String(dataUrl.length)}`)
      return { ok: true, dataUrl }
    } catch (error) {
      const failure = error instanceof ArtifactImageError ? error : null
      const code = failure?.code ?? 'protocol'
      this.log(
        `failed code=${code}${failure?.origin ? ` origin=${failure.origin}` : ''} ms=${String(Date.now() - started)}`,
      )
      return { ok: false, code, retryable: isRetryableArtifactImageError(code) }
    }
  }

  private log(line: string): void {
    this.dependencies.log?.(`[artifact-image] provider=cursor ${line}`)
  }

  private async authorizeAndLoad(request: ArtifactImageRequest): Promise<string> {
    const path = validateArtifactPath(request.path)
    let link: RemoteAgentLink | null
    try {
      link = await this.dependencies.readThreadLink(request.projectId, request.threadId)
    } catch {
      throw new ArtifactImageError('invalid-request')
    }
    // Exact durable provenance only. An agent ID in transcript text or the
    // request selects among the thread's links; it never creates one.
    if (!link) throw new ArtifactImageError('unlinked-agent')
    if (request.agentId !== undefined && request.agentId !== link.agentId) {
      throw new ArtifactImageError('unlinked-agent')
    }
    if (link.provider !== 'cursor') throw new ArtifactImageError('unsupported-provider')
    if (!this.dependencies.sandboxPlatform()) throw new ArtifactImageError('sandbox-unavailable')
    let credentials: { baseUrl: string; apiKey: string }
    try {
      credentials = this.dependencies.credentials()
    } catch {
      throw new ArtifactImageError('not-configured')
    }

    const agentId = link.agentId
    const key = [
      request.projectId,
      request.threadId,
      link.provider,
      originOf(credentials.baseUrl),
      credentialGeneration(credentials.apiKey),
      agentId,
      path,
    ].join('\u0000')
    // Authorization ran above for this request, so a cached image is served
    // only to a thread that still holds the link.
    const cached = this.cache.get(key)
    if (cached) return cached
    const existing = this.inFlight.get(key)
    if (existing) return existing

    const generation = this.generation
    const promise = this.enqueue(key, `${request.projectId}\u0000${request.threadId}`, () =>
      this.download(credentials, agentId, path),
    ).then((dataUrl) => {
      if (generation === this.generation) this.cache.set(key, dataUrl)
      return dataUrl
    })
    this.inFlight.set(key, promise)
    try {
      return await promise
    } finally {
      this.inFlight.delete(key)
    }
  }

  private enqueue(key: string, threadKey: string, run: () => Promise<string>): Promise<string> {
    if (this.queue.length >= MAX_QUEUED_JOBS) {
      return Promise.reject(new ArtifactImageError('busy'))
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ key, threadKey, run, resolve, reject })
      this.pump()
    })
  }

  /** Two jobs app-wide, one per thread; a thread's next job waits for its slot. */
  private pump(): void {
    while (this.active < MAX_CONCURRENT_JOBS) {
      const index = this.queue.findIndex((job) => !this.activeThreads.has(job.threadKey))
      if (index === -1) return
      const [job] = this.queue.splice(index, 1)
      if (!job) return
      this.active++
      this.activeThreads.add(job.threadKey)
      job
        .run()
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--
          this.activeThreads.delete(job.threadKey)
          this.pump()
        })
    }
  }

  private async download(
    credentials: { baseUrl: string; apiKey: string },
    agentId: string,
    path: string,
  ): Promise<string> {
    const abort = new AbortController()
    let signedUrl: string
    try {
      signedUrl = await this.dependencies.resolveDownloadUrl({
        ...credentials,
        agentId,
        path,
        signal: abort.signal,
      })
    } catch {
      // Provider errors may quote request details; keep only the code.
      throw new ArtifactImageError('metadata-failed')
    }
    // A returned URL never authorizes its own destination.
    checkDownloadUrl(signedUrl, CURSOR_ARTIFACT_DOWNLOAD_ORIGINS)

    const requestId = this.dependencies.newRequestId?.() ?? randomBytes(16).toString('hex')
    const job: HostJob = {
      v: ARTIFACT_IMAGE_PROTOCOL_VERSION,
      type: 'job',
      requestId,
      url: signedUrl,
      approvedOrigins: [...CURSOR_ARTIFACT_DOWNLOAD_ORIGINS],
    }
    // Main verifies the host's relay on its own; the host's checks are not trusted.
    const assembler = new ImageFrameAssembler(requestId)
    const outcome: { image?: VerifiedArtifactImage; failure?: ArtifactImageError } = {}
    await this.dependencies.runHost(
      job,
      (frame) => {
        if (outcome.image || outcome.failure) return
        try {
          const image = assembler.accept(frame)
          if (image) outcome.image = image
        } catch (error) {
          outcome.failure =
            error instanceof ArtifactImageError ? error : new ArtifactImageError('protocol')
          abort.abort()
        }
      },
      abort.signal,
    )
    if (outcome.failure) throw outcome.failure
    // A host that exits without a verified completion produced nothing usable.
    if (!outcome.image) throw new ArtifactImageError('protocol')
    return `data:${outcome.image.mime};base64,${outcome.image.bytes.toString('base64')}`
  }
}
