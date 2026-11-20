import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import {
  IMMUTABLE_CACHE_CONTROL,
  acceptedCoding,
  assetResponse,
  entityTag,
  etagMatches,
  jsonResponse,
  pageAsset,
  pinPageAssets,
  type PageAsset,
  type ResponseSpec,
} from './http-response.ts'

const script = { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }
const sheet = { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' }
const source = Buffer.from('export const greeting = "hello from the desktop"\n'.repeat(200))

function decoded(spec: ResponseSpec): string {
  assert.ok(spec.body)
  const coding = spec.headers['Content-Encoding']
  if (coding === 'br') return brotliDecompressSync(spec.body).toString('utf8')
  if (coding === 'gzip') return gunzipSync(spec.body).toString('utf8')
  assert.equal(coding, undefined)
  return spec.body.toString('utf8')
}

describe('content coding negotiation', () => {
  it('prefers Brotli, then gzip, and otherwise sends the bytes as they are', () => {
    assert.equal(acceptedCoding('gzip, deflate, br'), 'br')
    assert.equal(acceptedCoding('gzip, deflate'), 'gzip')
    assert.equal(acceptedCoding('GZIP'), 'gzip')
    assert.equal(acceptedCoding('deflate'), null)
    assert.equal(acceptedCoding('identity'), null)
    assert.equal(acceptedCoding(''), null)
    assert.equal(acceptedCoding(undefined), null)
  })

  it('honours a coding the client refused', () => {
    assert.equal(acceptedCoding('br;q=0, gzip'), 'gzip')
    assert.equal(acceptedCoding('br;q=0, gzip;q=0'), null)
    assert.equal(acceptedCoding('br; q=0.0, gzip; q=0.5'), 'gzip')
    // A wildcard stands in for a coding the header does not name, never for one it refused.
    assert.equal(acceptedCoding('*'), 'br')
    assert.equal(acceptedCoding('br;q=0, *'), 'gzip')
    assert.equal(acceptedCoding('*;q=0'), null)
  })
})

describe('validators', () => {
  it('matches a validator weakly, in a list, and by wildcard', () => {
    const tag = entityTag('body')
    assert.match(tag, /^W\/"[\w-]{43}"$/)
    assert.equal(etagMatches(tag, tag), true)
    assert.equal(etagMatches(tag.replace(/^W\//, ''), tag), true)
    assert.equal(etagMatches(`"other", ${tag}`, tag), true)
    assert.equal(etagMatches('*', tag), true)
    assert.equal(etagMatches(entityTag('another body'), tag), false)
    assert.equal(etagMatches(undefined, tag), false)
    assert.equal(etagMatches('', tag), false)
  })
})

describe('fixed assets', () => {
  it('names its bytes by hash, for the URL and for Subresource Integrity', () => {
    const asset = pageAsset(source, script)
    const digest = createHash('sha256').update(source).digest()
    assert.equal(asset.version, digest.toString('base64url'))
    assert.equal(asset.integrity, `sha256-${digest.toString('base64')}`)
  })

  it('sends each coding the client accepts, and the original bytes otherwise', async () => {
    const asset = pageAsset(source, script)
    for (const [acceptEncoding, coding] of [
      ['br, gzip', 'br'],
      ['gzip', 'gzip'],
      [undefined, undefined],
    ] as const) {
      const spec = await assetResponse(asset, { acceptEncoding })
      assert.equal(spec.status, 200)
      assert.equal(spec.headers['Content-Encoding'], coding)
      assert.equal(spec.headers['Vary'], 'Accept-Encoding')
      assert.equal(spec.headers['Content-Length'], String(spec.body?.length))
      assert.equal(decoded(spec), source.toString('utf8'))
      if (coding) assert.ok((spec.body?.length ?? Infinity) < source.length / 4)
    }
  })

  it('compresses each coding once however often it is requested', async () => {
    const asset = pageAsset(source, script)
    const [first, second] = await Promise.all([asset.encoded('br'), asset.encoded('br')])
    assert.equal(first, second)
    assert.equal(await asset.encoded('br'), first)
    assert.notEqual(await asset.encoded('gzip'), first)
  })

  it('leaves already-compressed and tiny bodies alone', async () => {
    const image = pageAsset(source, { 'Content-Type': 'image/png' })
    assert.equal((await assetResponse(image, { acceptEncoding: 'br' })).body, source)
    const tiny = pageAsset(Buffer.from('ok'), script)
    const spec = await assetResponse(tiny, { acceptEncoding: 'br' })
    assert.equal(spec.headers['Content-Encoding'], undefined)
    assert.equal(spec.body?.toString(), 'ok')
  })

  it('may be kept for good only under the URL that names its own bytes', async () => {
    const asset = pageAsset(source, script)
    const pinned = await assetResponse(asset, { version: asset.version })
    assert.equal(pinned.headers['Cache-Control'], IMMUTABLE_CACHE_CONTROL)
    // No `?v=` at all, an empty or stale one, and one that is nearly right.
    assert.equal((await assetResponse(asset, {})).headers['Cache-Control'], 'no-store')
    for (const version of [null, '', 'stale', asset.version.slice(1)]) {
      const spec = await assetResponse(asset, { version })
      assert.equal(spec.headers['Cache-Control'], 'no-store', String(version))
    }
  })

  it('answers a matching validator without a body', async () => {
    const asset = pageAsset(source, script)
    const spec = await assetResponse(asset, { ifNoneMatch: asset.etag, acceptEncoding: 'br' })
    assert.equal(spec.status, 304)
    assert.equal(spec.body, null)
    assert.equal(spec.headers['ETag'], asset.etag)
    assert.equal(spec.headers['Content-Length'], undefined)
    assert.equal((await assetResponse(asset, { ifNoneMatch: '"stale"' })).status, 200)
  })
})

describe('pinning a page to its bundles', () => {
  const assets = new Map<string, PageAsset>([
    ['/app.css', pageAsset(Buffer.from('body{}'), sheet)],
    ['/app.js', pageAsset(Buffer.from('void 0'), script)],
    ['/remote/chat.js', pageAsset(Buffer.from('void 1'), script)],
    ['/remote/chat.css', pageAsset(Buffer.from('main{}'), sheet)],
    ['/mermaid-frame.html', pageAsset(Buffer.from('<p>'), { 'Content-Type': 'text/html' })],
  ])
  const pinned = (route: string): string => {
    const asset = assets.get(route)
    assert.ok(asset)
    return `?v=${asset.version}" integrity="${asset.integrity}"`
  }

  it('pins the companion page’s stylesheet and script', async () => {
    const html = await readFile(new URL('../../../mobile/index.html', import.meta.url), 'utf8')
    const result = pinPageAssets(html, '/', assets)
    assert.ok(result.includes(`<link rel="stylesheet" href="app.css${pinned('/app.css')} />`))
    assert.ok(result.includes(`<script src="app.js${pinned('/app.js')} defer></script>`))
    // Nothing else moved: undoing the two pins gives back the source document.
    assert.equal(result.replace(pinned('/app.css'), '"').replace(pinned('/app.js'), '"'), html)
  })

  it('pins the shared chat page’s stylesheet and script, and not its link home', async () => {
    const html = await readFile(
      new URL('../../../renderer/remote/index.html', import.meta.url),
      'utf8',
    )
    const result = pinPageAssets(html, '/remote/', assets)
    assert.ok(result.includes(`href="/remote/chat.css${pinned('/remote/chat.css')}`))
    assert.ok(result.includes(`src="/remote/chat.js${pinned('/remote/chat.js')}`))
    assert.ok(result.includes('<a href="/">'), 'a link to another document is not a subresource')
  })

  it('resolves a reference against the document that makes it', () => {
    const html = '<script src="chat.js"></script><script src="../app.js"></script>'
    const result = pinPageAssets(html, '/remote/', assets)
    assert.ok(result.includes(`src="chat.js${pinned('/remote/chat.js')}`))
    assert.ok(result.includes(`src="../app.js${pinned('/app.js')}`))
  })

  it('leaves alone whatever it cannot vouch for', () => {
    for (const html of [
      '<script src="unknown.js"></script>',
      '<script src="https://elsewhere.example/app.js"></script>',
      '<script src="//elsewhere.example/app.js"></script>',
      '<iframe src="mermaid-frame.html"></iframe>',
      '<script src="app.js?v=already"></script>',
      '<script data-src="app.js"></script>',
    ])
      assert.equal(pinPageAssets(html, '/', assets), html)
  })
})

describe('JSON answers', () => {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  const rows = Array.from({ length: 200 }, (_, index) => ({ id: index, title: 'A thread title' }))

  it('compresses a body worth compressing and keeps it never-stored', async () => {
    const spec = await jsonResponse(headers, 200, { rows }, { acceptEncoding: 'gzip, br' })
    assert.equal(spec.headers['Content-Encoding'], 'br')
    assert.equal(spec.headers['Cache-Control'], 'no-store')
    assert.equal(spec.headers['Content-Length'], String(spec.body?.length))
    assert.deepEqual(JSON.parse(decoded(spec)), { rows })
    const plain = await jsonResponse(headers, 200, { rows })
    assert.equal(plain.headers['Content-Encoding'], undefined)
    assert.ok((spec.body?.length ?? Infinity) < (plain.body?.length ?? 0) / 4)
  })

  it('sends a small body as it is', async () => {
    const spec = await jsonResponse(headers, 404, { error: 'Not found' }, { acceptEncoding: 'br' })
    assert.equal(spec.status, 404)
    assert.equal(spec.headers['Content-Encoding'], undefined)
    assert.equal(decoded(spec), '{"error":"Not found"}')
  })

  it('answers an unchanged body with 304 and a changed one in full', async () => {
    const first = await jsonResponse(headers, 200, { rows }, {}, true)
    const etag = first.headers['ETag']
    assert.ok(etag)
    const unchanged = await jsonResponse(headers, 200, { rows }, { ifNoneMatch: etag }, true)
    assert.equal(unchanged.status, 304)
    assert.equal(unchanged.body, null)
    assert.equal(unchanged.headers['ETag'], etag)
    const changed = await jsonResponse(
      headers,
      200,
      { rows: rows.slice(1) },
      { ifNoneMatch: etag },
      true,
    )
    assert.equal(changed.status, 200)
    assert.notEqual(changed.headers['ETag'], etag)
  })

  it('validates by the tag it is given when the body always changes', async () => {
    const etag = entityTag(JSON.stringify({ rows }))
    const at = (refreshedAt: number): Promise<ResponseSpec> =>
      jsonResponse(headers, 200, { rows, refreshedAt }, { ifNoneMatch: etag }, etag)
    assert.equal((await at(1)).status, 304)
    assert.equal((await at(2)).status, 304)
  })

  it('never answers 304 for a read that carries no validator', async () => {
    const spec = await jsonResponse(headers, 200, { rows }, { ifNoneMatch: '*' })
    assert.equal(spec.status, 200)
    assert.equal(spec.headers['ETag'], undefined)
  })
})
