import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fetchSignedArtifact, MAX_EXPLICIT_ARTIFACT_BYTES } from './bounded-artifact-download.ts'

const ORIGIN = 'https://cloud-agent-artifacts.s3.us-east-1.amazonaws.com'
const SIGNED = `${ORIGIN}/file.zip?X-Amz-Signature=secret-token`

describe('explicit artifact byte download', () => {
  it('accepts arbitrary file MIME and keeps manual redirects on the approved origin', async () => {
    const requested: string[] = []
    const fetcher: typeof fetch = async (input, init) => {
      requested.push(
        input instanceof Request ? input.url : input instanceof URL ? input.href : input,
      )
      assert.equal(init?.redirect, 'manual')
      return requested.length === 1
        ? new Response(null, { status: 302, headers: { Location: '/second.zip?signature=next' } })
        : new Response('archive', {
            status: 200,
            headers: { 'Content-Type': 'application/zip', 'Content-Length': '7' },
          })
    }
    assert.equal((await fetchSignedArtifact(SIGNED, fetcher)).toString(), 'archive')
    assert.deepEqual(requested, [SIGNED, `${ORIGIN}/second.zip?signature=next`])
  })

  it('refuses a signed URL or redirect to another origin before a second request', async () => {
    let requests = 0
    const fetcher: typeof fetch = async () => {
      requests++
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://downloads.evil.example/private' },
      })
    }
    await assert.rejects(fetchSignedArtifact('https://downloads.evil.example/file', fetcher))
    assert.equal(requests, 0)
    await assert.rejects(fetchSignedArtifact(SIGNED, fetcher))
    assert.equal(requests, 1)
  })

  it('bounds declared and streamed response sizes', async () => {
    const declared: typeof fetch = async () =>
      new Response(null, {
        status: 200,
        headers: { 'Content-Length': String(MAX_EXPLICIT_ARTIFACT_BYTES + 1) },
      })
    await assert.rejects(fetchSignedArtifact(SIGNED, declared), /too large/)
    const streamed: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(new Uint8Array(MAX_EXPLICIT_ARTIFACT_BYTES + 1))
            controller.close()
          },
        }),
        { status: 200 },
      )
    await assert.rejects(fetchSignedArtifact(SIGNED, streamed), /too large/)
  })

  it('rejects a missing body when a nonempty response was declared', async () => {
    const missing: typeof fetch = async () =>
      new Response(null, { status: 200, headers: { 'Content-Length': '7' } })
    await assert.rejects(fetchSignedArtifact(SIGNED, missing), /incomplete/)
    const short: typeof fetch = async () =>
      new Response('abc', { status: 200, headers: { 'Content-Length': '7' } })
    await assert.rejects(fetchSignedArtifact(SIGNED, short), /incomplete/)
  })

  it('stops after three same-origin redirects without leaking the URL', async () => {
    let requests = 0
    const loop: typeof fetch = async () => {
      requests++
      return new Response(null, { status: 302, headers: { Location: SIGNED } })
    }
    await assert.rejects(fetchSignedArtifact(SIGNED, loop), (error: Error) => {
      assert.doesNotMatch(error.message, /secret-token/)
      return true
    })
    assert.equal(requests, 4)
  })

  it('does not relay a fetch error containing the bearer URL', async () => {
    const fetcher: typeof fetch = async () => {
      throw new Error(SIGNED)
    }
    await assert.rejects(fetchSignedArtifact(SIGNED, fetcher), (error: Error) => {
      assert.doesNotMatch(error.message, /secret-token/)
      return true
    })
  })
})
