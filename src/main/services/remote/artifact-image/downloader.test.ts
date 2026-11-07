import { after, afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import {
  downloadArtifactImage,
  proxyPortFromEnv,
  proxyTunnelTransport,
  type DownloadLimits,
  type DownloadTransport,
} from './downloader.ts'
import { startEgressProxy } from './egress-proxy.ts'
import { gifBytes, pngBytes } from './image-fixtures.test-support.ts'
import {
  ArtifactImageError,
  MAX_ARTIFACT_IMAGE_BYTES,
  type ArtifactImageErrorCode,
} from './policy.ts'

const ORIGIN = 'https://cloud-agent-artifacts.s3.us-east-1.amazonaws.com'
const HOST = new URL(ORIGIN).hostname
const TARGET =
  '/agents/bc-1/artifacts/shot.png?X-Amz-Credential=AKIA%2F20261030&X-Amz-Signature=deadbeef'
const URL_ = `${ORIGIN}${TARGET}`
const JOB = { url: URL_, approvedOrigins: [ORIGIN] }
const FAST: DownloadLimits = { deadlineMs: 2_000, idleMs: 300 }

interface RawServer {
  port: number
  requests: string[]
  /** Bytes the server managed to write before the client went away. */
  written: () => number
}

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/**
 * A raw TCP "origin" so tests can send exactly the bytes a hostile server
 * would: lying headers, trickled bytes, oversized bodies.
 */
async function rawServer(
  respond: (socket: Socket, request: string, index: number) => void,
): Promise<RawServer> {
  const requests: string[] = []
  let closedBytes = 0
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => {
      closedBytes += socket.bytesWritten
      sockets.delete(socket)
    })
    socket.on('error', () => {})
    let head = ''
    socket.setEncoding('latin1')
    socket.on('data', (chunk: string) => {
      head += chunk
      if (!head.includes('\r\n\r\n')) return
      const index = requests.push(head) - 1
      respond(socket, head, index)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => {
          resolve()
        })
      }),
  )
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    port: address.port,
    requests,
    written: () => [...sockets].reduce((total, socket) => total + socket.bytesWritten, closedBytes),
  }
}

function plainTransport(port: number, opened: string[] = []): DownloadTransport {
  return {
    open(hostname): Promise<Socket> {
      opened.push(hostname)
      return new Promise((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => {
          resolve(socket)
        })
        socket.once('error', reject)
      })
    },
  }
}

function head(status: string, headers: Record<string, string | number>): string {
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${String(value)}`)
  return `HTTP/1.1 ${status}\r\n${lines.join('\r\n')}\r\n\r\n`
}

async function failure(promise: Promise<unknown>): Promise<ArtifactImageError> {
  try {
    await promise
  } catch (error) {
    assert.ok(
      error instanceof ArtifactImageError,
      `expected ArtifactImageError, got ${String(error)}`,
    )
    return error
  }
  assert.fail('expected the download to fail')
}

async function code(promise: Promise<unknown>): Promise<ArtifactImageErrorCode> {
  return (await failure(promise)).code
}

describe('downloadArtifactImage against a hostile origin', () => {
  it('downloads a valid image with a minimal, credential-free request', async () => {
    const image = pngBytes()
    const server = await rawServer((socket) => {
      socket.end(
        Buffer.concat([
          Buffer.from(
            head('200 OK', { 'Content-Type': 'image/png', 'Content-Length': image.length }),
          ),
          image,
        ]),
      )
    })
    const result = await downloadArtifactImage(JOB, plainTransport(server.port), FAST)
    assert.equal(result.mime, 'image/png')
    assert.deepEqual(result.bytes, image)
    const request = server.requests[0] ?? ''
    // The signed target goes out byte-for-byte.
    assert.ok(request.startsWith(`GET ${TARGET} HTTP/1.1\r\n`), request)
    assert.match(request, /\r\nHost: cloud-agent-artifacts\.s3\.us-east-1\.amazonaws\.com\r\n/iu)
    assert.match(request, /\r\nAccept-Encoding: identity\r\n/iu)
    assert.doesNotMatch(request, /\r\n(authorization|cookie|referer|proxy-authorization):/iu)
  })

  it('refuses an honest oversized Content-Length before reading the body', async () => {
    const server = await rawServer((socket) => {
      socket.write(
        head('200 OK', {
          'Content-Type': 'image/png',
          'Content-Length': MAX_ARTIFACT_IMAGE_BYTES + 1,
        }),
      )
    })
    assert.equal(
      await code(downloadArtifactImage(JOB, plainTransport(server.port), FAST)),
      'too-large',
    )
  })

  it('stops a chunked body with no Content-Length at the first overrun', async () => {
    const block = Buffer.alloc(1024 * 1024, 1)
    const server = await rawServer((socket) => {
      socket.write(head('200 OK', { 'Content-Type': 'image/png', 'Transfer-Encoding': 'chunked' }))
      let sent = 0
      const pump = (): void => {
        while (sent < 40 && !socket.destroyed) {
          sent++
          const payload = Buffer.concat([pngBytes(), block])
          const chunk = Buffer.concat([
            Buffer.from(`${payload.length.toString(16)}\r\n`),
            payload,
            Buffer.from('\r\n'),
          ])
          if (!socket.write(chunk)) {
            socket.once('drain', pump)
            return
          }
        }
        if (!socket.destroyed) socket.end('0\r\n\r\n')
      }
      pump()
    })
    assert.equal(
      await code(downloadArtifactImage(JOB, plainTransport(server.port), FAST)),
      'too-large',
    )
    // The client went away long before the 40 MiB the server was willing to send.
    assert.ok(server.written() < 30 * 1024 * 1024, `server wrote ${String(server.written())} bytes`)
  })

  it('never reads past a lying (too small) Content-Length', async () => {
    const image = pngBytes()
    const server = await rawServer((socket) => {
      socket.end(
        Buffer.concat([
          Buffer.from(
            head('200 OK', { 'Content-Type': 'image/png', 'Content-Length': image.length }),
          ),
          image,
          Buffer.alloc(2 * 1024 * 1024, 9),
        ]),
      )
    })
    // Either the declared bytes and nothing more, or Node's parser refuses the
    // trailing data outright; never the extra 2 MiB.
    try {
      const result = await downloadArtifactImage(JOB, plainTransport(server.port), FAST)
      assert.equal(result.bytes.length, image.length)
    } catch (error) {
      assert.ok(error instanceof ArtifactImageError)
      assert.equal(error.code, 'protocol')
    }
  })

  it('fails a body shorter than its Content-Length as incomplete', async () => {
    const image = pngBytes()
    const server = await rawServer((socket) => {
      socket.end(
        Buffer.concat([
          Buffer.from(
            head('200 OK', { 'Content-Type': 'image/png', 'Content-Length': image.length + 50 }),
          ),
          image,
        ]),
      )
    })
    assert.equal(
      await code(downloadArtifactImage(JOB, plainTransport(server.port), FAST)),
      'network',
    )
  })

  for (const [label, location, expected] of [
    ['a private address', 'https://10.0.0.5/x.png', 'redirect-denied'],
    ['the metadata service', 'https://169.254.169.254/latest/meta-data/iam', 'redirect-denied'],
    ['loopback by name', 'https://localhost/x.png', 'redirect-denied'],
    ['an unapproved origin', 'https://evil.example/x.png', 'redirect-denied'],
    ['plain http', `http://${HOST}/x.png`, 'redirect-denied'],
    ['another port', `${ORIGIN}:8443/x.png`, 'redirect-denied'],
  ] as const) {
    it(`refuses a redirect to ${label} without opening a connection to it`, async () => {
      const server = await rawServer((socket) => {
        socket.end(head('302 Found', { Location: location, 'Content-Length': 0 }))
      })
      const opened: string[] = []
      assert.equal(
        await code(downloadArtifactImage(JOB, plainTransport(server.port, opened), FAST)),
        expected,
      )
      assert.deepEqual(opened, [HOST])
    })
  }

  it('follows an approved same-origin redirect', async () => {
    const image = gifBytes()
    const server = await rawServer((socket, _request, index) => {
      if (index === 0)
        socket.end(
          head('307 Temporary Redirect', { Location: '/next.gif?sig=2', 'Content-Length': 0 }),
        )
      else
        socket.end(
          Buffer.concat([
            Buffer.from(
              head('200 OK', { 'Content-Type': 'image/gif', 'Content-Length': image.length }),
            ),
            image,
          ]),
        )
    })
    const result = await downloadArtifactImage(JOB, plainTransport(server.port), FAST)
    assert.equal(result.mime, 'image/gif')
    assert.ok(server.requests[1]?.startsWith('GET /next.gif?sig=2 HTTP/1.1'))
  })

  it('stops a redirect loop after three redirects', async () => {
    const server = await rawServer((socket) => {
      socket.end(head('302 Found', { Location: URL_, 'Content-Length': 0 }))
    })
    const opened: string[] = []
    assert.equal(
      await code(downloadArtifactImage(JOB, plainTransport(server.port, opened), FAST)),
      'too-many-redirects',
    )
    assert.equal(opened.length, 4)
  })

  it('reports the proxy refusing a redirect target as a redirect denial', async () => {
    const server = await rawServer((socket) => {
      socket.end(head('302 Found', { Location: '/x.png', 'Content-Length': 0 }))
    })
    let opens = 0
    const inner = plainTransport(server.port)
    const transport: DownloadTransport = {
      open(hostname, signal) {
        if (opens++ > 0) return Promise.reject(new ArtifactImageError('origin-denied', ORIGIN))
        return inner.open(hostname, signal)
      },
    }
    assert.equal(await code(downloadArtifactImage(JOB, transport, FAST)), 'redirect-denied')
  })

  for (const [label, contentType] of [
    ['HTML', 'text/html'],
    ['SVG', 'image/svg+xml'],
    ['generic image/*', 'image/*'],
    ['a missing type', ''],
  ] as const) {
    it(`refuses ${label}`, async () => {
      const body = Buffer.from('<svg onload="alert(1)"/>')
      const server = await rawServer((socket) => {
        const headers: Record<string, string | number> = { 'Content-Length': body.length }
        if (contentType) headers['Content-Type'] = contentType
        socket.end(Buffer.concat([Buffer.from(head('200 OK', headers)), body]))
      })
      assert.equal(
        await code(downloadArtifactImage(JOB, plainTransport(server.port), FAST)),
        'bad-type',
      )
    })
  }

  it('refuses bytes that do not match the declared image type', async () => {
    const body = gifBytes()
    const server = await rawServer((socket) => {
      socket.end(
        Buffer.concat([
          Buffer.from(
            head('200 OK', { 'Content-Type': 'image/png', 'Content-Length': body.length }),
          ),
          body,
        ]),
      )
    })
    assert.equal(
      await code(downloadArtifactImage(JOB, plainTransport(server.port), FAST)),
      'bad-type',
    )
  })

  it('refuses a dimension bomb', async () => {
    const body = pngBytes(20_000, 20_000)
    const server = await rawServer((socket) => {
      socket.end(
        Buffer.concat([
          Buffer.from(
            head('200 OK', { 'Content-Type': 'image/png', 'Content-Length': body.length }),
          ),
          body,
        ]),
      )
    })
    assert.equal(
      await code(downloadArtifactImage(JOB, plainTransport(server.port), FAST)),
      'bad-image',
    )
  })

  it('refuses a compressed body instead of decompressing it', async () => {
    const body = pngBytes()
    const server = await rawServer((socket) => {
      socket.end(
        Buffer.concat([
          Buffer.from(
            head('200 OK', {
              'Content-Type': 'image/png',
              'Content-Encoding': 'gzip',
              'Content-Length': body.length,
            }),
          ),
          body,
        ]),
      )
    })
    assert.equal(
      await code(downloadArtifactImage(JOB, plainTransport(server.port), FAST)),
      'bad-encoding',
    )
  })

  it('refuses oversized response headers', async () => {
    const server = await rawServer((socket) => {
      socket.end(head('200 OK', { 'Content-Type': 'image/png', 'X-Pad': 'a'.repeat(40 * 1024) }))
    })
    assert.equal(
      await code(downloadArtifactImage(JOB, plainTransport(server.port), FAST)),
      'protocol',
    )
  })

  it('reports a non-success status without echoing the response body', async () => {
    const body = 'AccessDenied: X-Amz-Signature=deadbeef'
    const server = await rawServer((socket) => {
      socket.end(
        `${head('403 Forbidden', { 'Content-Type': 'text/plain', 'Content-Length': body.length })}${body}`,
      )
    })
    const error = await failure(downloadArtifactImage(JOB, plainTransport(server.port), FAST))
    assert.equal(error.code, 'http-status')
    assert.equal(error.message, 'http-status: 403')
  })

  it('times out a slow-loris server that trickles its headers', async () => {
    const server = await rawServer((socket) => {
      const bytes = head('200 OK', { 'Content-Type': 'image/png', 'Content-Length': 100 })
      let index = 0
      const timer = setInterval(() => {
        if (socket.destroyed || index >= bytes.length) {
          clearInterval(timer)
          return
        }
        socket.write(bytes[index++] ?? '')
      }, 100)
      socket.on('close', () => {
        clearInterval(timer)
      })
    })
    const started = Date.now()
    assert.equal(
      await code(
        downloadArtifactImage(JOB, plainTransport(server.port), { deadlineMs: 600, idleMs: 300 }),
      ),
      'timeout',
    )
    assert.ok(Date.now() - started < 2_000)
  })

  it('times out a body that stalls mid-stream', async () => {
    const image = pngBytes()
    const server = await rawServer((socket) => {
      socket.write(
        head('200 OK', { 'Content-Type': 'image/png', 'Content-Length': image.length + 1000 }),
      )
      socket.write(image)
      // ...and then nothing, with the connection held open.
    })
    const started = Date.now()
    assert.equal(
      await code(
        downloadArtifactImage(JOB, plainTransport(server.port), { deadlineMs: 5_000, idleMs: 200 }),
      ),
      'timeout',
    )
    assert.ok(Date.now() - started < 2_000)
  })

  it('rechecks the job URL itself rather than trusting main', async () => {
    const opened: string[] = []
    assert.equal(
      await code(
        downloadArtifactImage(
          { url: 'https://evil.example/x.png', approvedOrigins: [ORIGIN] },
          plainTransport(1, opened),
          FAST,
        ),
      ),
      'origin-denied',
    )
    assert.deepEqual(opened, [])
  })
})

describe('proxyPortFromEnv', () => {
  it('accepts only a loopback HTTP proxy', () => {
    assert.equal(proxyPortFromEnv({ HTTPS_PROXY: 'http://localhost:3128' }), 3128)
    assert.equal(proxyPortFromEnv({ HTTPS_PROXY: 'http://127.0.0.1:41000' }), 41000)
    assert.equal(proxyPortFromEnv({ HTTPS_PROXY: 'http://proxy.corp.example:3128' }), null)
    assert.equal(proxyPortFromEnv({ HTTPS_PROXY: 'socks5h://localhost:1080' }), null)
    assert.equal(proxyPortFromEnv({}), null)
  })
})

describe('proxyTunnelTransport with real TLS', () => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-image-tls-'))
  let rightCert: Buffer
  let rightKey: Buffer
  let wrongCert: Buffer
  let wrongKey: Buffer

  function selfSigned(name: string, prefix: string): void {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(root, `${prefix}-key.pem`),
        '-out',
        join(root, `${prefix}-cert.pem`),
        '-days',
        '1',
        '-subj',
        `/CN=${name}`,
        '-addext',
        `subjectAltName=DNS:${name}`,
      ],
      { stdio: 'ignore' },
    )
  }

  before(() => {
    selfSigned(HOST, 'right')
    selfSigned('other.example', 'wrong')
    rightCert = readFileSync(join(root, 'right-cert.pem'))
    rightKey = readFileSync(join(root, 'right-key.pem'))
    wrongCert = readFileSync(join(root, 'wrong-cert.pem'))
    wrongKey = readFileSync(join(root, 'wrong-key.pem'))
  })
  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function origin(cert: Buffer, key: Buffer): Promise<number> {
    const image = pngBytes()
    const server: HttpsServer = createHttpsServer({ cert, key }, (req, res) => {
      assert.equal(req.headers.authorization, undefined)
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.length })
      res.end(image)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => {
            resolve()
          })
        }),
    )
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    return address.port
  }

  async function proxyTo(originPort: number, token: string): Promise<number> {
    const proxy = await startEgressProxy({
      token,
      allowedHosts: [HOST],
      // A public answer for the policy; the injected dialer reaches the local origin.
      resolve: () => Promise.resolve(['52.216.8.10']),
      connect: () => connect(originPort, '127.0.0.1'),
    })
    cleanups.push(() => proxy.close())
    return proxy.port
  }

  // The test trusts its own self-signed roots; verification itself stays on.
  const trusting = (ca: Buffer): Parameters<typeof proxyTunnelTransport>[2] => ({
    tlsConnect: (options) => tlsConnect({ ...options, ca }),
  })

  it('downloads through the proxy with TLS verified against the origin name', async () => {
    const token = 'a'.repeat(64)
    const port = await proxyTo(await origin(rightCert, rightKey), token)
    const result = await downloadArtifactImage(
      JOB,
      proxyTunnelTransport(port, token, trusting(rightCert)),
      FAST,
    )
    assert.equal(result.mime, 'image/png')
  })

  it('fails closed when the certificate names another host', async () => {
    const token = 'b'.repeat(64)
    const port = await proxyTo(await origin(wrongCert, wrongKey), token)
    assert.equal(
      await code(
        downloadArtifactImage(JOB, proxyTunnelTransport(port, token, trusting(wrongCert)), FAST),
      ),
      'tls',
    )
  })

  it('fails closed against an untrusted certificate', async () => {
    const token = 'c'.repeat(64)
    const port = await proxyTo(await origin(rightCert, rightKey), token)
    assert.equal(
      await code(downloadArtifactImage(JOB, proxyTunnelTransport(port, token), FAST)),
      'tls',
    )
  })

  it('cannot use the proxy with the wrong job token', async () => {
    const port = await proxyTo(await origin(rightCert, rightKey), 'd'.repeat(64))
    assert.equal(
      await code(
        downloadArtifactImage(
          JOB,
          proxyTunnelTransport(port, 'e'.repeat(64), trusting(rightCert)),
          FAST,
        ),
      ),
      'network',
    )
  })
})
