import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http'
import { connect } from 'node:net'
import { PassThrough } from 'node:stream'
import { EgressBroker } from './egress-broker.ts'
import { EgressLink } from './egress-link.ts'
import { parseEgressRule } from './egress-rules.ts'
import { probeBroker, startGuestEgressProxy, type GuestEgressProxy } from './guest-egress-proxy.ts'

/**
 * The guest proxy end to end, in one process: proxy → link → broker → origin.
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
  let origin: { port: number; close: () => void; seen: string[] }
  let broker: EgressBroker
  let link: EgressLink
  let proxy: GuestEgressProxy

  before(async () => {
    origin = await startOrigin()
    broker = new EgressBroker({
      rules: [
        parseEgressRule(`model.copse.internal:${String(origin.port)}`),
        parseEgressRule('down.copse.internal:9'),
      ],
      resolve: { 'model.copse.internal': '127.0.0.1', 'down.copse.internal': '127.0.0.1:9' },
    })
    const guestToHost = new PassThrough()
    const hostToGuest = new PassThrough()
    broker.attach(guestToHost, hostToGuest)
    link = new EgressLink(hostToGuest, guestToHost)
    proxy = await startGuestEgressProxy(link, { host: '127.0.0.1', port: 0 })
  })

  after(async () => {
    await proxy.close()
    broker.stop()
    origin.close()
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

  it('closes while a client still holds a CONNECT tunnel open, instead of waiting on it', async () => {
    // A second proxy on the same link, so the shared one stays up for the
    // tests after this. An SDK that pools its connection keeps the tunnel up
    // between requests; the worker's close must not wait for it to hang up.
    const own = await startGuestEgressProxy(link, { host: '127.0.0.1', port: 0 })
    const socket = connect(own.address.port, own.address.host)
    const established = new Promise<void>((resolveTunnel, reject) => {
      let received = ''
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8')
        if (received.includes('200 Connection Established\r\n\r\n')) resolveTunnel()
      })
      socket.on('error', reject)
      socket.once('connect', () => {
        socket.write(
          `CONNECT model.copse.internal:${String(origin.port)} HTTP/1.1\r\nHost: model.copse.internal\r\n\r\n`,
        )
      })
    })
    await established
    const closed = new Promise<void>((resolveClosed) => {
      socket.once('close', () => {
        resolveClosed()
      })
    })
    const outcome = await Promise.race([
      own.close().then(() => 'closed' as const),
      new Promise<'hung'>((resolveHung) => {
        setTimeout(() => {
          resolveHung('hung')
        }, 2_000)
      }),
    ])
    assert.equal(outcome, 'closed')
    await closed
    assert.equal(socket.destroyed, true, "the client's end of the tunnel is gone too")
  })

  it('closes while a CONNECT is still being dialled, and refuses the tunnel if it opens after', async () => {
    // A link nobody answers: the dial stays pending for as long as the test
    // likes, which is a slow resolver or a far origin from the proxy's side.
    const unanswered = new EgressLink(new PassThrough(), new PassThrough())
    const own = await startGuestEgressProxy(unanswered, { host: '127.0.0.1', port: 0 })
    const socket = connect(own.address.port, own.address.host)
    let received = ''
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8')
    })
    socket.on('error', () => {
      // Reset by the close below; that is the point.
    })
    await new Promise<void>((resolveConnected) => {
      socket.once('connect', () => {
        socket.write(
          'CONNECT model.copse.internal:443 HTTP/1.1\r\nHost: model.copse.internal\r\n\r\n',
        )
        resolveConnected()
      })
    })
    // Let the CONNECT reach the proxy and start its dial.
    await new Promise((resolveTick) => setTimeout(resolveTick, 50))
    const outcome = await Promise.race([
      own.close().then(() => 'closed' as const),
      new Promise<'hung'>((resolveHung) => {
        setTimeout(() => {
          resolveHung('hung')
        }, 2_000)
      }),
    ])
    assert.equal(outcome, 'closed')
    await new Promise<void>((resolveClosed) => {
      if (socket.destroyed) resolveClosed()
      else {
        socket.once('close', () => {
          resolveClosed()
        })
      }
    })
    assert.equal(received.includes('200 Connection Established'), false)
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

  it('answers 502, not 403, for an allowed origin that did not answer, so clients retry', async () => {
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
        socket.write('CONNECT down.copse.internal:9 HTTP/1.1\r\nHost: down.copse.internal\r\n\r\n')
      })
    })
    assert.match(reply, /^HTTP\/1\.1 502 Bad Gateway/)
    assert.match(reply, /DENY origin unreachable: connect ECONNREFUSED/)
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

  it('refuses every request without the run token, with a 407, when one is set', async () => {
    const refused: string[] = []
    const gated = await startGuestEgressProxy(
      link,
      { host: '127.0.0.1', port: 0 },
      { token: 'run-token-1', onRefused: (target) => refused.push(target) },
    )
    try {
      const auth = `Basic ${Buffer.from('run:run-token-1').toString('base64')}`
      const status = (headers: Record<string, string>): Promise<number> =>
        new Promise((resolve, reject) => {
          const req = httpRequest(
            {
              host: gated.address.host,
              port: gated.address.port,
              method: 'GET',
              path: `http://model.copse.internal:${String(origin.port)}/ping`,
              headers,
            },
            (res) => {
              res.resume()
              res.on('end', () => {
                resolve(res.statusCode ?? 0)
              })
            },
          )
          req.on('error', reject)
          req.end()
        })
      // A shell child handed the proxy address alone: refused before the
      // broker is even asked, and the refusal is reported.
      assert.equal(await status({}), 407)
      assert.equal(await status({ 'proxy-authorization': 'Basic d3Jvbmc6dG9rZW4=' }), 407)
      assert.deepEqual(refused.length, 2)
      // The worker's own client, and the agent, carry the token and go through.
      assert.equal(await status({ 'proxy-authorization': auth }), 200)
      // CONNECT without the token is refused the same way.
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = connect(gated.address.port, gated.address.host)
        let buffer = ''
        socket.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
        })
        socket.on('close', () => {
          resolve(buffer)
        })
        socket.on('error', reject)
        socket.write(`CONNECT model.copse.internal:${String(origin.port)} HTTP/1.1\r\n\r\n`)
      })
      assert.match(reply, /^HTTP\/1\.1 407 /)
    } finally {
      await gated.close()
    }
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

  it('probes a live broker, and names the fault when nothing answers', async () => {
    await probeBroker(link)
    const silent = new EgressLink(new PassThrough(), new PassThrough())
    await assert.rejects(probeBroker(silent, 50), /no reply within 50ms/)
    silent.close(undefined)
  })

  it('reports each tunnel the broker refused, with the reason the client saw', async () => {
    const failures: string[] = []
    const reporting = await startGuestEgressProxy(
      link,
      { host: '127.0.0.1', port: 0 },
      { onTunnelError: (target, reason) => failures.push(`${target} ${reason}`) },
    )
    try {
      await new Promise<void>((resolveTunnel, reject) => {
        const socket = connect(reporting.address.port, reporting.address.host)
        // Drain the 403 so the socket can reach 'end', and so 'close'.
        socket.resume()
        socket.on('close', () => {
          resolveTunnel()
        })
        socket.on('error', reject)
        socket.once('connect', () => {
          socket.write('CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example\r\n\r\n')
        })
      })
    } finally {
      await reporting.close()
    }
    assert.deepEqual(failures, ['evil.example:443 DENY not in the allowlist'])
  })
})
