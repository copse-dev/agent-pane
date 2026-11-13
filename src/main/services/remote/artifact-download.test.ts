import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { RemoteAgentLink } from '@shared/remote-agent-link.ts'
import type { RemoteArtifactDownloadRequest } from '@shared/remote-artifact-download.ts'
import {
  createArtifactDownloader,
  zArtifactDownloadRequest,
  type ArtifactDownloadDependencies,
} from './artifact-download.ts'

const SIGNED =
  'https://cloud-agent-artifacts.s3.us-east-1.amazonaws.com/shot.png?X-Amz-Signature=private-token'
const LINK: RemoteAgentLink = { provider: 'cursor', agentId: 'bc-linked', createdAt: 1 }
const REQUEST: RemoteArtifactDownloadRequest = {
  projectId: 'project',
  threadId: 'thread',
  agentId: 'bc-linked',
  path: 'artifacts/shot.png',
}

interface Harness {
  download: ReturnType<typeof createArtifactDownloader>
  metadataCalls: Array<{ agentId: string; path: string }>
  fetched: string[]
  saved: Array<{ path: string; data: Buffer }>
}

function harness(overrides: Partial<ArtifactDownloadDependencies> = {}): Harness {
  const metadataCalls: Array<{ agentId: string; path: string }> = []
  const fetched: string[] = []
  const saved: Array<{ path: string; data: Buffer }> = []
  const readThreadProvenance: ArtifactDownloadDependencies['readThreadProvenance'] = async (
    projectId,
    threadId,
  ) => {
    if (projectId !== 'project' || threadId !== 'thread') throw new Error('unknown thread')
    return { link: LINK, cursorAgentIds: ['bc-linked'] }
  }
  const download = createArtifactDownloader({
    readThreadProvenance,
    readOpenAiArtifact: async () => Buffer.from('cached artifact'),
    chooseSavePath: async () => '/tmp/artifact.png',
    writeFile: async (path, data) => {
      saved.push({ path, data })
    },
    resolveCursorUrl: async (agentId, path) => {
      metadataCalls.push({ agentId, path })
      return SIGNED
    },
    fetchCursorBytes: async (url) => {
      fetched.push(url)
      return Buffer.from('downloaded artifact')
    },
    ...overrides,
  })
  return { download, metadataCalls, fetched, saved }
}

describe('explicit artifact download', () => {
  it('requires a bounded project, thread, agent and path at the IPC boundary', () => {
    assert.deepEqual(zArtifactDownloadRequest.parse(REQUEST), REQUEST)
    assert.equal(zArtifactDownloadRequest.safeParse({ ...REQUEST, projectId: '' }).success, false)
    assert.equal(zArtifactDownloadRequest.safeParse({ ...REQUEST, agentId: '' }).success, false)
    assert.equal(zArtifactDownloadRequest.safeParse({ ...REQUEST, extra: 'value' }).success, false)
  })

  it('saves a linked Cursor artifact without returning its signed URL', async () => {
    const h = harness()
    await h.download(REQUEST)
    assert.deepEqual(h.metadataCalls, [{ agentId: 'bc-linked', path: 'artifacts/shot.png' }])
    assert.deepEqual(h.fetched, [SIGNED])
    assert.deepEqual(h.saved, [
      { path: '/tmp/artifact.png', data: Buffer.from('downloaded artifact') },
    ])
  })

  for (const [label, request] of [
    ['a spoofed agent', { ...REQUEST, agentId: 'bc-spoofed' }],
    ['another thread', { ...REQUEST, threadId: 'other-thread' }],
    ['another project', { ...REQUEST, projectId: 'other-project' }],
    ['an invalid path', { ...REQUEST, path: 'artifacts/../secret' }],
  ] as const) {
    it(`rejects ${label} before provider access`, async () => {
      const h = harness()
      await assert.rejects(h.download(request))
      assert.deepEqual(h.metadataCalls, [])
      assert.deepEqual(h.fetched, [])
    })
  }

  it('rejects an unlinked or differently linked thread', async () => {
    for (const link of [
      null,
      { ...LINK, agentId: 'bc-other' },
      { ...LINK, provider: 'openai' } satisfies RemoteAgentLink,
    ]) {
      const h = harness({
        readThreadProvenance: async () => ({ link, cursorAgentIds: [] }),
      })
      await assert.rejects(h.download(REQUEST), /not linked/)
      assert.deepEqual(h.metadataCalls, [])
    }
  })

  it('saves an older Cursor agent artifact after the chat starts a new agent', async () => {
    const h = harness({
      readThreadProvenance: async () => ({
        link: { ...LINK, agentId: 'bc-new' },
        cursorAgentIds: ['bc-linked', 'bc-new'],
      }),
    })
    await h.download(REQUEST)
    assert.deepEqual(h.metadataCalls, [{ agentId: 'bc-linked', path: 'artifacts/shot.png' }])
    assert.deepEqual(h.saved, [
      { path: '/tmp/artifact.png', data: Buffer.from('downloaded artifact') },
    ])
  })

  it('accepts a prior Cursor launch after an OpenAI launch, but never history alone', async () => {
    const switched = harness({
      readThreadProvenance: async () => ({
        link: { provider: 'openai', agentId: 'openai-current', createdAt: 2 },
        cursorAgentIds: ['bc-linked'],
      }),
    })
    await switched.download(REQUEST)
    assert.deepEqual(switched.metadataCalls, [{ agentId: 'bc-linked', path: 'artifacts/shot.png' }])
    const unlinked = harness({
      readThreadProvenance: async () => ({ link: null, cursorAgentIds: ['bc-linked'] }),
    })
    await assert.rejects(unlinked.download(REQUEST), /not linked/)
    assert.deepEqual(unlinked.metadataCalls, [])
  })

  it('does not contact the provider when the user cancels Save', async () => {
    const h = harness({ chooseSavePath: async () => null })
    await h.download(REQUEST)
    assert.deepEqual(h.metadataCalls, [])
    assert.deepEqual(h.fetched, [])
    assert.deepEqual(h.saved, [])
  })

  it('rejects a signed URL outside the approved origin before opening it', async () => {
    const h = harness({
      resolveCursorUrl: async () => 'https://untrusted.example/file?token=secret',
    })
    await assert.rejects(h.download(REQUEST))
    assert.deepEqual(h.fetched, [])
  })

  it('does not expose a signed URL in a platform error', async () => {
    const h = harness({
      fetchCursorBytes: async () => {
        throw new Error(SIGNED)
      },
    })
    await assert.rejects(h.download(REQUEST), (error: Error) => {
      assert.doesNotMatch(error.message, /private-token/)
      return true
    })
  })

  it('does not expose provider errors containing a signed URL', async () => {
    const h = harness({
      resolveCursorUrl: async () => {
        throw new Error(SIGNED)
      },
    })
    await assert.rejects(h.download(REQUEST), (error: Error) => {
      assert.doesNotMatch(error.message, /private-token/)
      return true
    })
    assert.deepEqual(h.fetched, [])
  })

  it('saves a cached OpenAI artifact from its owning thread', async () => {
    const request = {
      ...REQUEST,
      agentId: 'openai:thread',
      path: `${'a'.repeat(64)}/${'b'.repeat(64)}.png`,
    }
    const reads: Array<{ projectId: string; threadId: string; path: string }> = []
    const h = harness({
      readThreadProvenance: async () => ({ link: null, cursorAgentIds: [] }),
      readOpenAiArtifact: async (projectId, threadId, path) => {
        reads.push({ projectId, threadId, path })
        return Buffer.from('cached artifact')
      },
    })
    await h.download(request)
    assert.deepEqual(reads, [{ projectId: 'project', threadId: 'thread', path: request.path }])
    assert.deepEqual(h.saved, [{ path: '/tmp/artifact.png', data: Buffer.from('cached artifact') }])
    assert.deepEqual(h.metadataCalls, [])
  })

  it('rejects a spoofed OpenAI thread before reading the cache', async () => {
    let reads = 0
    const h = harness({
      readOpenAiArtifact: async () => {
        reads++
        return Buffer.alloc(0)
      },
    })
    await assert.rejects(h.download({ ...REQUEST, agentId: 'openai:other-thread' }), /not linked/)
    assert.equal(reads, 0)
  })
})
