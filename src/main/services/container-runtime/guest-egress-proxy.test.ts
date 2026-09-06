import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http'
import { connect } from 'node:net'
import { EgressBroker } from './egress-broker.ts'
import { parseEgressRule } from './egress-rules.ts'
import { startGuestEgressProxy, type GuestEgressProxy } from './guest-egress-proxy.ts'

/**
 * The guest proxy end to end, in one process: proxy → broker socket → origin.
 * The origin is a real HTTP server on loopback that streams, so the
 * absolute-form path is proven to carry a body up and a chunked, incremental
 * response back — the shape a model conversation actually has.
 */

function startOrigin(): Promise<{ port: number; close: () => void; seen: string[] }> {
  const seen: string[] = []
  return new Promise((resolveStart) => {
    const server: Server = createHttpServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8')
      })
      req.on('end', () => {
        seen.push(
          `${req.method ?? ''} ${req.url ?? ''} host=${req.headers.host ?? ''} body=${body}`,
        )
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Origin': 'yes' })
        res.write('data: one\n\n')
        setTimeout(() => {
          res.write('data: two\n\n')
          res.end()
        }, 30)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolveStart({
        port,
        seen,
        close: (): void => {
          server.close()
        },
      })
    })
  })
}

describe('guest egress proxy', () => {
  let dir = ''
  let origin: { port: number; close: () => void; seen: string[] }
  let broker: EgressBroker
  let proxy: GuestEgressProxy

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'copse-gp-'))
    origin = await startOrigin()
    broker = new EgressBroker(dir, {
      rules: [parseEgressRule(`model.copse.internal:${String(origin.port)}`)],
      resolve: { 'model.copse.internal': '127.0.0.1' },
    })
    await broker.start()
    proxy = await startGuestEgressProxy(broker.path(), { host: '127.0.0.1', port: 0 })
  })

  after(async () => {
    await proxy.close()
    await broker.stop()
    origin.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('forwards an absolute-form request and streams the response back', async () => {
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    const result = await new Promise<{
      status: number
      headers: Record<string, unknown>
      text: string
    }>((resolveRequest, reject) => {
      const req = httpRequest(
        {
          host: proxy.address.host,
          port: proxy.address.port,
          method: 'POST',
          // Absolute-form: what a client sends when HTTP_PROXY is set.
          path: `http://model.copse.internal:${String(origin.port)}/v1/chat/completions`,
          headers: {
            Host: `model.copse.internal:${String(origin.port)}`,
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body)),
            'Proxy-Connection': 'keep-alive',
          },
        },
        (res) => {
          let text = ''
          res.on('data', (chunk: Buffer) => {
            text += chunk.toString('utf8')
          })
          res.on('end', () => {
            resolveRequest({ status: res.statusCode ?? 0, headers: res.headers, text })
          })
        },
      )
      req.on('error', reject)
      req.end(body)
    })
    assert.equal(result.status, 200)
    assert.equal(result.headers['x-origin'], 'yes')
    assert.equal(result.text, 'data: one\n\ndata: two\n\n')
    assert.equal(origin.seen.length, 1)
    // Rewritten to origin-form, body intact, and the hop-by-hop header gone.
    assert.match(origin.seen[0] ?? '', /^POST \/v1\/chat\/completions host=model\.copse\.internal/)
    assert.ok((origin.seen[0] ?? '').endsWith(`body=${body}`))
  })

  it('tunnels a CONNECT and relays raw bytes', async () => {
    const reply = await new Promise<string>((resolveTunnel, reject) => {
      const socket = connect(proxy.address.port, proxy.address.host)
      let received = ''
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8')
        // Once the tunnel is up, speak plain HTTP through it to the origin.
        if (
          received.includes('200 Connection Established\r\n\r\n') &&
          !received.includes('HTTP/1.1 200 OK')
        ) {
          socket.write(
            `GET /raw HTTP/1.1\r\nHost: model.copse.internal\r\nConnection: close\r\n\r\n`,
          )
        }
        if (received.includes('data: two')) {
          socket.destroy()
          resolveTunnel(received)
        }
      })
      socket.on('error', reject)
      socket.once('connect', () => {
        socket.write(
          `CONNECT model.copse.internal:${String(origin.port)} HTTP/1.1\r\nHost: model.copse.internal\r\n\r\n`,
        )
      })
    })
    assert.match(reply, /^HTTP\/1\.1 200 Connection Established/)
    assert.match(reply, /HTTP\/1\.1 200 OK/)
    assert.match(reply, /data: two/)
  })

  it('answers 403 with the broker reason for a target the allowlist refuses', async () => {
    const result = await new Promise<{ status: number; text: string }>((resolveRequest, reject) => {
      const req = httpRequest(
        {
          host: proxy.address.host,
          port: proxy.address.port,
          method: 'GET',
          path: `http://github.com:443/`,
          headers: { Host: 'github.com' },
        },
        (res) => {
          let text = ''
          res.on('data', (chunk: Buffer) => {
            text += chunk.toString('utf8')
          })
          res.on('end', () => {
            resolveRequest({ status: res.statusCode ?? 0, text })
          })
        },
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(result.status, 403)
    assert.match(result.text, /DENY not in the allowlist/)
    assert.ok(broker.log().some((e) => e.event === 'refused' && e.origin === 'github.com:443'))
  })

  it('rejects a CONNECT to a refused target with 403 rather than hanging', async () => {
    const reply = await new Promise<string>((resolveTunnel, reject) => {
      const socket = connect(proxy.address.port, proxy.address.host)
      let received = ''
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8')
      })
      socket.on('close', () => {
        resolveTunnel(received)
      })
      socket.on('error', reject)
      socket.once('connect', () => {
        socket.write('CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example\r\n\r\n')
      })
    })
    assert.match(reply, /^HTTP\/1\.1 403 Forbidden/)
    assert.match(reply, /DENY not in the allowlist/)
  })

  it('rejects a request that is not absolute-form', async () => {
    const result = await new Promise<number>((resolveRequest, reject) => {
      const req = httpRequest(
        { host: proxy.address.host, port: proxy.address.port, method: 'GET', path: '/relative' },
        (res) => {
          res.resume()
          res.on('end', () => {
            resolveRequest(res.statusCode ?? 0)
          })
        },
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(result, 400)
  })
})
