import { before, describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer as httpServer, type RequestListener, type Server } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { Agent } from 'undici'
import { disableBrotliDecoding, nodeHasBrotliDecoderFix } from './brotli-decode-guard.ts'

// Public, test-only self-signed certificate for model.example; verification stays enabled.
const cert = readFileSync('tests/fixtures/cli-provider-transport/model.crt')
const key = readFileSync('tests/fixtures/cli-provider-transport/model.key')

const unguardedFetch = globalThis.fetch
const DISABLED = /Brotli decoding is disabled in this process \(CVE-2026-111497\)/

async function listen(t: TestContext, server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `127.0.0.1:${String(address.port)}`
}

const encodedResponses: RequestListener = (request, response) => {
  if (request.url === '/br') {
    response.writeHead(200, { 'content-encoding': 'br' })
    response.end(zlib.brotliCompressSync('decoded'))
  } else if (request.url === '/br-empty') {
    response.writeHead(200, { 'content-encoding': 'br' })
    response.end()
  } else {
    response.writeHead(200, { 'content-encoding': 'gzip' })
    response.end(zlib.gzipSync('decoded'))
  }
}

describe('nodeHasBrotliDecoderFix', () => {
  it('accepts the first fixed release of each maintained line and later ones', () => {
    for (const version of ['22.23.4', '24.22.1', '24.23.0', '26.12.1', '26.13.0', '27.0.0']) {
      assert.equal(nodeHasBrotliDecoderFix(version), true, version)
    }
  })

  it('rejects earlier releases and end-of-life lines', () => {
    // 24.21.0 is Electron 44.7.0's Node; 24.22.0 is Electron 44.9.3's and 45.0.0's.
    for (const version of ['22.23.3', '24.21.0', '24.22.0', '26.12.0', '25.9.0', '23.11.1']) {
      assert.equal(nodeHasBrotliDecoderFix(version), false, version)
    }
  })
})

describe('disableBrotliDecoding', () => {
  before(disableBrotliDecoding)

  it('fails Brotli responses to fetch without hanging, and still decodes gzip', async (t) => {
    const origin = await listen(t, httpServer(encodedResponses))
    for (const path of ['/br', '/br-empty']) {
      await assert.rejects(
        async () => {
          const response = await fetch(`http://${origin}${path}`, {
            signal: AbortSignal.timeout(5_000),
          })
          await response.text()
        },
        (error: unknown) => {
          assert.ok(error instanceof TypeError && error.cause instanceof Error, String(error))
          assert.match(error.cause.message, DISABLED)
          return true
        },
        path,
      )
    }
    assert.equal(await (await fetch(`http://${origin}/gzip`)).text(), 'decoded')
  })

  it('stops fetch asking HTTPS servers for br unless the caller chose encodings', async (t) => {
    const asked: (string | undefined)[] = []
    const origin = await listen(
      t,
      httpsServer({ cert, key }, (request, response) => {
        asked.push(request.headers['accept-encoding'])
        response.end('ok')
      }),
    )
    const agent = new Agent({ connect: { ca: cert, servername: 'model.example' } })
    t.after(() => agent.close())
    const url = `https://${origin}/`
    const init: RequestInit & { dispatcher: Agent } = { dispatcher: agent }

    await (await unguardedFetch(url, init)).text()
    await (await fetch(url, init)).text()
    await (await fetch(new Request(url, { headers: { 'x-kept': '1' } }), init)).text()
    await (await fetch(url, { ...init, headers: { 'Accept-Encoding': 'br' } })).text()
    await (await fetch(url, { ...init, headers: { Range: 'bytes=0-1' } })).text()

    assert.deepEqual(asked, [
      'br, gzip, deflate',
      'gzip, deflate',
      'gzip, deflate',
      'br',
      'identity',
    ])
  })

  it('fails every zlib Brotli decoder entry point and leaves compression alone', async () => {
    const compressed = zlib.brotliCompressSync('payload')
    assert.throws(() => zlib.brotliDecompressSync(compressed), DISABLED)
    await assert.rejects(promisify(zlib.brotliDecompress)(compressed), DISABLED)
    for (const decoder of [zlib.createBrotliDecompress(), new zlib.BrotliDecompress()]) {
      const sink = new Writable({
        write: (_chunk, _encoding, done): void => {
          done()
        },
      })
      await assert.rejects(pipeline(Readable.from([compressed]), decoder, sink), DISABLED)
    }
    assert.equal(zlib.gunzipSync(zlib.gzipSync('payload')).toString(), 'payload')
  })
})
