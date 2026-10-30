import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { RemoteAgentLink } from '@shared/remote-agent-link.ts'
import { pngBytes } from './image-fixtures.test-support.ts'
import { errorFrame, imageFrames, type HostJob, type ImageFrame } from './protocol.ts'
import {
  ArtifactImageService,
  zArtifactImageRequest,
  type ArtifactImageRequest,
  type ArtifactImageServiceDependencies,
} from './service.ts'

const ORIGIN = 'https://cloud-agent-artifacts.s3.us-east-1.amazonaws.com'
const SIGNED = `${ORIGIN}/agents/bc-1/shot.png?X-Amz-Signature=sig`
const LINK: RemoteAgentLink = { provider: 'cursor', agentId: 'bc-linked', createdAt: 1 }
const REQUEST: ArtifactImageRequest = {
  projectId: 'p1',
  threadId: 't1',
  path: 'artifacts/shot.png',
}

interface Harness {
  service: ArtifactImageService
  metadataCalls: Array<{ agentId: string; path: string; apiKey: string }>
  hostJobs: HostJob[]
  logs: string[]
  state: {
    link: RemoteAgentLink | null
    apiKey: string
    signedUrl: string
    sandbox: boolean
    frames: (job: HostJob) => ImageFrame[]
    hostDelay: number
  }
}

function harness(overrides: Partial<ArtifactImageServiceDependencies> = {}): Harness {
  const metadataCalls: Harness['metadataCalls'] = []
  const hostJobs: HostJob[] = []
  const logs: string[] = []
  const state: Harness['state'] = {
    link: LINK,
    apiKey: 'key-1',
    signedUrl: SIGNED,
    sandbox: true,
    frames: (job) => imageFrames(job.requestId, 'image/png', pngBytes()),
    hostDelay: 0,
  }
  let nextId = 0
  const service = new ArtifactImageService({
    readThreadLink: (projectId, threadId): Promise<RemoteAgentLink | null> => {
      if (projectId !== 'p1' || threadId.startsWith('missing')) {
        return Promise.reject(new Error('unknown thread'))
      }
      return Promise.resolve(state.link)
    },
    credentials: (): { baseUrl: string; apiKey: string } => ({ baseUrl: 'https://api.cursor.com', apiKey: state.apiKey }),
    resolveDownloadUrl: (input): Promise<string> => {
      metadataCalls.push({ agentId: input.agentId, path: input.path, apiKey: input.apiKey })
      return Promise.resolve(state.signedUrl)
    },
    sandboxPlatform: (): boolean => state.sandbox,
    runHost: async (job, onFrame): Promise<void> => {
      hostJobs.push(job)
      if (state.hostDelay) await new Promise((resolve) => setTimeout(resolve, state.hostDelay))
      for (const frame of state.frames(job)) onFrame(frame)
    },
    newRequestId: (): string => (nextId++).toString(16).padStart(32, '0'),
    log: (line): void => {
      logs.push(line)
    },
    ...overrides,
  })
  return { service, metadataCalls, hostJobs, logs, state }
}

describe('ArtifactImageService', () => {
  it('authorizes, resolves once, downloads in the host and returns a verified data URL', async () => {
    const h = harness()
    const result = await h.service.load(REQUEST)
    assert.deepEqual(result, {
      ok: true,
      dataUrl: `data:image/png;base64,${pngBytes().toString('base64')}`,
    })
    assert.deepEqual(h.metadataCalls, [
      { agentId: 'bc-linked', path: 'artifacts/shot.png', apiKey: 'key-1' },
    ])
    const [job, ...others] = h.hostJobs
    assert.ok(job)
    assert.equal(others.length, 0)
    assert.deepEqual(job.approvedOrigins, [ORIGIN])
    assert.equal(job.url, SIGNED)
  })

  for (const [label, request, code] of [
    ['a spoofed agent id', { ...REQUEST, agentId: 'bc-from-transcript' }, 'unlinked-agent'],
    ['a traversal path', { ...REQUEST, path: 'artifacts/../../etc/passwd' }, 'invalid-path'],
    ['an encoded traversal path', { ...REQUEST, path: 'artifacts/%2e%2e/x.png' }, 'invalid-path'],
    ['an unknown thread', { ...REQUEST, threadId: 'missing-thread' }, 'invalid-request'],
    ['another project', { ...REQUEST, projectId: 'p2' }, 'invalid-request'],
  ] as const) {
    it(`refuses ${label} before any network request`, async () => {
      const h = harness()
      const result = await h.service.load(request)
      assert.deepEqual(result, { ok: false, code, retryable: false })
      assert.deepEqual(h.metadataCalls, [])
      assert.deepEqual(h.hostJobs, [])
    })
  }

  it('accepts an agent selector that matches the durable link', async () => {
    const h = harness()
    assert.equal((await h.service.load({ ...REQUEST, agentId: 'bc-linked' })).ok, true)
  })

  it('refuses a thread with no durable link before any network request', async () => {
    const h = harness()
    h.state.link = null
    assert.deepEqual(await h.service.load(REQUEST), {
      ok: false,
      code: 'unlinked-agent',
      retryable: false,
    })
    assert.deepEqual(h.metadataCalls, [])
  })

  it('refuses a non-Cursor link', async () => {
    const h = harness()
    h.state.link = { provider: 'anthropic', agentId: 'bc-linked', createdAt: 1 }
    assert.equal((await h.service.load(REQUEST)).ok, false)
    assert.deepEqual(h.metadataCalls, [])
  })

  it('fails closed without a sandbox platform and never falls back to a direct fetch', async () => {
    const h = harness()
    h.state.sandbox = false
    assert.deepEqual(await h.service.load(REQUEST), {
      ok: false,
      code: 'sandbox-unavailable',
      retryable: false,
    })
    assert.deepEqual(h.metadataCalls, [])
    assert.deepEqual(h.hostJobs, [])
  })

  it('denies a signed URL on an unapproved origin without starting a host, logging only the origin', async () => {
    const h = harness()
    h.state.signedUrl = 'https://evil.example/x.png?X-Amz-Signature=secret'
    assert.deepEqual(await h.service.load(REQUEST), {
      ok: false,
      code: 'origin-denied',
      retryable: false,
    })
    assert.deepEqual(h.hostJobs, [])
    assert.ok(h.logs.some((line) => line.includes('origin=https://evil.example')))
    assert.ok(h.logs.every((line) => !line.includes('secret')))
  })

  it('maps a failed metadata request to a bounded, retryable code', async () => {
    const h = harness({
      resolveDownloadUrl: () =>
        Promise.reject(new Error('HTTP 500: {"url":"https://x/?sig=secret"}')),
    })
    assert.deepEqual(await h.service.load(REQUEST), {
      ok: false,
      code: 'metadata-failed',
      retryable: true,
    })
    assert.ok(h.logs.every((line) => !line.includes('secret')))
  })

  it('relays the host’s error code', async () => {
    const h = harness()
    h.state.frames = (job): ImageFrame[] => [errorFrame(job.requestId, 'redirect-denied', 'https://evil.example')]
    assert.deepEqual(await h.service.load(REQUEST), {
      ok: false,
      code: 'redirect-denied',
      retryable: false,
    })
  })

  it('verifies the host relay itself: a forged digest or wrong type never becomes an image', async () => {
    const forged = harness()
    forged.state.frames = (job): ImageFrame[] => {
      const frames = imageFrames(job.requestId, 'image/png', pngBytes())
      const done = frames.at(-1)
      assert.ok(done?.type === 'done')
      return [...frames.slice(0, -1), { ...done, sha256: '0'.repeat(64) }]
    }
    assert.deepEqual(await forged.service.load(REQUEST), {
      ok: false,
      code: 'protocol',
      retryable: true,
    })

    const relabelled = harness()
    relabelled.state.frames = (job): ImageFrame[] => imageFrames(job.requestId, 'image/jpeg', pngBytes())
    assert.deepEqual(await relabelled.service.load(REQUEST), {
      ok: false,
      code: 'bad-type',
      retryable: false,
    })
  })

  it('treats a host that exits without completing as a failure, never partial output', async () => {
    const h = harness()
    h.state.frames = (job): ImageFrame[] =>
      imageFrames(job.requestId, 'image/png', pngBytes()).slice(0, -1)
    assert.deepEqual(await h.service.load(REQUEST), {
      ok: false,
      code: 'protocol',
      retryable: true,
    })
  })

  it('serves a cached image only after re-authorizing the thread', async () => {
    const h = harness()
    await h.service.load(REQUEST)
    assert.equal((await h.service.load(REQUEST)).ok, true)
    assert.equal(h.hostJobs.length, 1)
    // Unlinking the thread must stop the cached image too.
    h.state.link = null
    assert.deepEqual(await h.service.load(REQUEST), {
      ok: false,
      code: 'unlinked-agent',
      retryable: false,
    })
  })

  it('keys the cache by credential, so a rotated key fetches afresh', async () => {
    const h = harness()
    await h.service.load(REQUEST)
    h.state.apiKey = 'key-2'
    await h.service.load(REQUEST)
    assert.equal(h.hostJobs.length, 2)
    assert.ok(h.logs.every((line) => !line.includes('key-1') && !line.includes('key-2')))
  })

  it('does not let an in-flight result repopulate an invalidated cache', async () => {
    const h = harness()
    h.state.hostDelay = 20
    const pending = h.service.load(REQUEST)
    await new Promise((resolve) => setTimeout(resolve, 5))
    h.service.invalidate()
    assert.equal((await pending).ok, true)
    h.state.hostDelay = 0
    await h.service.load(REQUEST)
    assert.equal(h.hostJobs.length, 2)
  })

  it('deduplicates concurrent requests for the same image', async () => {
    const h = harness()
    h.state.hostDelay = 10
    const results = await Promise.all([h.service.load(REQUEST), h.service.load(REQUEST)])
    assert.ok(results.every((result) => result.ok))
    assert.equal(h.hostJobs.length, 1)
  })

  it('runs at most two jobs app-wide and one per thread', async () => {
    let active = 0
    let peak = 0
    const perThread = new Map<string, number>()
    let threadPeak = 0
    const h = harness({
      readThreadLink: () => Promise.resolve(LINK),
      runHost: async (job, onFrame) => {
        const thread = job.url.includes('t1') ? 't1' : 'other'
        active++
        perThread.set(thread, (perThread.get(thread) ?? 0) + 1)
        peak = Math.max(peak, active)
        threadPeak = Math.max(threadPeak, perThread.get(thread) ?? 0)
        await new Promise((resolve) => setTimeout(resolve, 10))
        for (const frame of imageFrames(job.requestId, 'image/png', pngBytes())) onFrame(frame)
        active--
        perThread.set(thread, (perThread.get(thread) ?? 1) - 1)
      },
      resolveDownloadUrl: (input) =>
        Promise.resolve(
          `${ORIGIN}/${input.path}?thread=${input.path.includes('t1-') ? 't1' : 'x'}`,
        ),
    })
    const requests = [
      { ...REQUEST, path: 'artifacts/t1-a.png' },
      { ...REQUEST, path: 'artifacts/t1-b.png' },
      { ...REQUEST, path: 'artifacts/t1-c.png' },
      { ...REQUEST, threadId: 't2', path: 'artifacts/x.png' },
      { ...REQUEST, threadId: 't3', path: 'artifacts/y.png' },
    ]
    const results = await Promise.all(requests.map((request) => h.service.load(request)))
    assert.ok(results.every((result) => result.ok))
    assert.ok(peak <= 2, `peak ${String(peak)}`)
    assert.equal(threadPeak, 1)
  })

  it('refuses work beyond the queue bound', async () => {
    const h = harness({ readThreadLink: () => Promise.resolve(LINK) })
    h.state.hostDelay = 30
    const requests = Array.from({ length: 20 }, (_, index) => ({
      ...REQUEST,
      threadId: `t${String(index)}`,
    }))
    const results = await Promise.all(requests.map((request) => h.service.load(request)))
    assert.ok(results.some((result) => !result.ok && result.code === 'busy'))
  })
})

describe('zArtifactImageRequest', () => {
  it('rejects extra fields from the renderer', () => {
    assert.equal(zArtifactImageRequest.safeParse(REQUEST).success, true)
    assert.equal(
      zArtifactImageRequest.safeParse({ ...REQUEST, url: 'https://evil.example' }).success,
      false,
    )
    assert.equal(
      zArtifactImageRequest.safeParse({ agentId: 'bc-1', path: 'artifacts/a.png' }).success,
      false,
    )
  })
})
