import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_IMAGE_BYTES,
  createRemoteImageFetcher,
  sameRepositoryContentsPath,
  sniffImageType,
  toToolResultImage,
  type BinaryFetchLike,
} from './review-images.ts'
import type { PullRequestRef } from './pr-conversation.ts'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const SHA = 'a517e0011776800309f93024f51aba3feb75ccb4'
const signal = new AbortController().signal

const REF: PullRequestRef = {
  forge: 'github',
  apiBase: 'https://api.github.com',
  owner: 'acme',
  repo: 'app',
  number: 7,
  token: 'secret-token',
}

interface Reply {
  readonly status: number
  readonly location?: string
  readonly bytes?: Uint8Array
  readonly length?: number
}

function fakeFetch(replies: Record<string, Reply>): {
  fetch: BinaryFetchLike
  calls: { url: string; headers: Record<string, string> }[]
} {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetch: BinaryFetchLike = (url, init) => {
    calls.push({ url, headers: init.headers })
    const reply = replies[url] ?? { status: 404 }
    const bytes = reply.bytes ?? new Uint8Array()
    return Promise.resolve({
      status: reply.status,
      headers: {
        get: (name: string): string | null =>
          name === 'location'
            ? (reply.location ?? null)
            : name === 'content-length'
              ? String(reply.length ?? bytes.byteLength)
              : null,
      },
      body: new Blob([bytes.slice()]).stream(),
    })
  }
  return { fetch, calls }
}

describe('image validation', () => {
  it('recognises the formats providers accept and nothing else', () => {
    assert.equal(sniffImageType(PNG), 'image/png')
    assert.equal(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
    assert.equal(sniffImageType(new TextEncoder().encode('GIF89a')), 'image/gif')
    assert.equal(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp')
    assert.equal(sniffImageType(new TextEncoder().encode('<svg xmlns=')), null)
    assert.throws(() => toToolResultImage(new TextEncoder().encode('<svg'), 'x.svg'), /not a PNG/)
    const image = toToolResultImage(PNG, 'shot.png')
    assert.match(image.dataUrl, /^data:image\/png;base64,/)
    assert.equal(image.name, 'shot.png')
  })
})

describe('sameRepositoryContentsPath', () => {
  it('maps this repository’s raw and blob links at a commit to the contents API', () => {
    const expected = `https://api.github.com/repos/acme/app/contents/tests/screens/a%20b.png?ref=${SHA}`
    for (const url of [
      `https://github.com/acme/app/raw/${SHA}/tests/screens/a%20b.png`,
      `https://github.com/Acme/App/blob/${SHA}/tests/screens/a%20b.png`,
      `https://raw.githubusercontent.com/acme/app/${SHA}/tests/screens/a%20b.png`,
    ]) {
      assert.equal(sameRepositoryContentsPath(REF, new URL(url)), expected, url)
    }
  })

  it('leaves another repository, a branch ref and Forgejo to a plain fetch', () => {
    for (const url of [
      `https://github.com/other/app/raw/${SHA}/a.png`,
      'https://github.com/acme/app/raw/screenshot-compare/pr-7/a.png',
      'https://github.com/user-attachments/assets/0f6c',
    ]) {
      assert.equal(sameRepositoryContentsPath(REF, new URL(url)), null, url)
    }
    assert.equal(
      sameRepositoryContentsPath(
        { ...REF, forge: 'forgejo', apiBase: 'https://code.example.org' },
        new URL(`https://code.example.org/acme/app/raw/${SHA}/a.png`),
      ),
      null,
    )
  })
})

describe('createRemoteImageFetcher', () => {
  it('reads a same-repository image through the API with the token', async () => {
    const api = `https://api.github.com/repos/acme/app/contents/a.png?ref=${SHA}`
    const { fetch, calls } = fakeFetch({ [api]: { status: 200, bytes: PNG } })
    const bytes = await createRemoteImageFetcher(REF, { fetch })(
      `https://github.com/acme/app/raw/${SHA}/a.png`,
      signal,
    )
    assert.deepEqual([...bytes], [...PNG])
    assert.equal(calls[0]?.headers['Authorization'], 'Bearer secret-token')
  })

  it('follows redirects between allowed hosts without ever sending the token there', async () => {
    const start = 'https://github.com/user-attachments/assets/0f6c'
    const cdn = 'https://private-user-images.githubusercontent.com/1/0f6c.png'
    const { fetch, calls } = fakeFetch({
      [start]: { status: 302, location: cdn },
      [cdn]: { status: 200, bytes: PNG },
    })
    await createRemoteImageFetcher(REF, { fetch })(start, signal)
    assert.deepEqual(
      calls.map((call) => call.url),
      [start, cdn],
    )
    assert.ok(calls.every((call) => call.headers['Authorization'] === undefined))
  })

  it('refuses a host that is not the forge’s or allowlisted, including after a redirect', async () => {
    const { fetch, calls } = fakeFetch({
      'https://github.com/acme/app/raw/main/a.png': {
        status: 302,
        location: 'https://evil.example/a.png',
      },
    })
    const fetchImage = createRemoteImageFetcher(REF, { fetch })
    await assert.rejects(fetchImage('https://evil.example/a.png', signal), /not an allowed/)
    assert.equal(calls.length, 0)
    await assert.rejects(
      fetchImage('https://github.com/acme/app/raw/main/a.png', signal),
      /evil\.example is not an allowed image host/,
    )
    const allowed = createRemoteImageFetcher(REF, {
      fetch: fakeFetch({ 'https://shots.example/a.png': { status: 200, bytes: PNG } }).fetch,
      extraHosts: ['shots.example'],
    })
    await allowed('https://shots.example/a.png', signal)
  })

  it('refuses an image larger than a provider accepts before reading it', async () => {
    const url = 'https://raw.githubusercontent.com/other/app/main/huge.png'
    const { fetch } = fakeFetch({ [url]: { status: 200, length: MAX_IMAGE_BYTES + 1 } })
    await assert.rejects(createRemoteImageFetcher(REF, { fetch })(url, signal), /larger than/)
  })

  it('stops reading a body with no Content-Length once it passes the cap', async () => {
    const url = 'https://raw.githubusercontent.com/other/app/main/endless.png'
    const chunk = new Uint8Array(1024 * 1024)
    let pulled = 0
    let cancelled = false
    const endless = new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          pulled += chunk.byteLength
          controller.enqueue(chunk)
        },
        cancel: () => {
          cancelled = true
        },
      },
      { highWaterMark: 0 },
    )
    const fetch: BinaryFetchLike = () =>
      Promise.resolve({ status: 200, headers: { get: () => null }, body: endless })
    await assert.rejects(createRemoteImageFetcher(REF, { fetch })(url, signal), /larger than/)
    assert.ok(cancelled, 'the stream is cancelled at the cap')
    assert.ok(pulled <= MAX_IMAGE_BYTES + chunk.byteLength, `read ${String(pulled)} bytes`)
  })
})
