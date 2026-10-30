import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { connect, createServer, type Server, type Socket } from 'node:net'
import {
  EGRESS_PROXY_USER,
  startEgressProxy,
  type EgressDecision,
  type EgressProxy,
} from './egress-proxy.ts'

const TOKEN = 'f'.repeat(64)
const HOST = 'cloud-agent-artifacts.s3.us-east-1.amazonaws.com'
const PUBLIC = '52.216.8.10'

function auth(token = TOKEN): string {
  return `Proxy-Authorization: Basic ${Buffer.from(`${EGRESS_PROXY_USER}:${token}`).toString('base64')}\r\n`
}

/** Send raw bytes and collect everything until the proxy closes or `until` matches. */
function exchange(port: number, raw: string | Buffer, until?: RegExp): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    let received = ''
    socket.setEncoding('latin1')
    socket.on('data', (chunk: string) => {
      received += chunk
      if (until?.test(received)) socket.destroy()
    })
    socket.on('close', () => { resolve(received); })
    socket.on('error', () => { resolve(received); })
    socket.write(raw)
  })
}

interface Harness {
  proxy: EgressProxy
  decisions: EgressDecision[]
  resolved: string[]
  dialed: string[]
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** An upstream that echoes with a prefix, standing in for the origin's port 443. */
async function echoServer(): Promise<number> {
  const server: Server = createServer((socket) => {
    socket.on('data', (chunk: Buffer) => socket.write(Buffer.concat([Buffer.from('echo:'), chunk])))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise((resolve) => server.close(() => { resolve(); })))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return address.port
}

async function harness(
  answers: (host: string, call: number) => string[],
  options: { headerTimeoutMs?: number; maxTunnels?: number } = {},
): Promise<Harness> {
  const upstreamPort = await echoServer()
  const decisions: EgressDecision[] = []
  const resolved: string[] = []
  const dialed: string[] = []
  let calls = 0
  const proxy = await startEgressProxy({
    token: TOKEN,
    allowedHosts: [HOST],
    resolve: (host) => {
      resolved.push(host)
      return Promise.resolve(answers(host, calls++))
    },
    connect: (address, port): Socket => {
      dialed.push(`${address}:${String(port)}`)
      return connect(upstreamPort, '127.0.0.1')
    },
    onDecision: (decision) => decisions.push(decision),
    ...options,
  })
  cleanups.push(() => proxy.close())
  return { proxy, decisions, resolved, dialed }
}

describe('artifact image egress proxy', () => {
  it('tunnels an authenticated CONNECT to an approved public host', async () => {
    const h = await harness(() => [PUBLIC])
    const reply = await exchange(
      h.proxy.port,
      `CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n${auth()}\r\n`,
      /200 Connection Established\r\n\r\n/u,
    )
    assert.match(reply, /^HTTP\/1\.1 200 /u)
    assert.deepEqual(h.dialed, [`${PUBLIC}:443`])
    assert.deepEqual(h.decisions, [{ outcome: 'allowed', host: HOST }])
  })

  it('relays tunnel bytes after the 200', async () => {
    const h = await harness(() => [PUBLIC])
    const reply = await new Promise<string>((resolve) => {
      const socket = connect(h.proxy.port, '127.0.0.1')
      let received = ''
      socket.setEncoding('latin1')
      socket.on('data', (chunk: string) => {
        received += chunk
        if (received.endsWith('\r\n\r\n')) socket.write('ping')
        if (received.includes('echo:ping')) socket.destroy()
      })
      socket.on('close', () => { resolve(received); })
      socket.write(`CONNECT ${HOST}:443 HTTP/1.1\r\n${auth()}\r\n`)
    })
    assert.match(reply, /echo:ping/u)
  })

  for (const [label, request, status, outcome] of [
    ['no credentials', `CONNECT ${HOST}:443 HTTP/1.1\r\n\r\n`, '407', 'unauthenticated'],
    [
      'a wrong token',
      `CONNECT ${HOST}:443 HTTP/1.1\r\n${auth('0'.repeat(64))}\r\n`,
      '407',
      'unauthenticated',
    ],
    ['a plain GET', `GET http://${HOST}/ HTTP/1.1\r\n${auth()}\r\n`, '405', 'method'],
    ['port 80', `CONNECT ${HOST}:80 HTTP/1.1\r\n${auth()}\r\n`, '403', 'authority'],
    [
      'an IPv4 literal',
      `CONNECT 169.254.169.254:443 HTTP/1.1\r\n${auth()}\r\n`,
      '403',
      'authority',
    ],
    ['an IPv6 literal', `CONNECT [::1]:443 HTTP/1.1\r\n${auth()}\r\n`, '403', 'authority'],
    [
      'an unapproved host',
      `CONNECT evil.example:443 HTTP/1.1\r\n${auth()}\r\n`,
      '403',
      'host-denied',
    ],
    ['a trailing-dot host', `CONNECT ${HOST}.:443 HTTP/1.1\r\n${auth()}\r\n`, '403', 'authority'],
    [
      'userinfo in the authority',
      `CONNECT a@${HOST}:443 HTTP/1.1\r\n${auth()}\r\n`,
      '403',
      'authority',
    ],
    [
      'a duplicated auth header',
      `CONNECT ${HOST}:443 HTTP/1.1\r\n${auth()}${auth()}\r\n`,
      '400',
      'malformed',
    ],
  ] as const) {
    it(`refuses ${label} without resolving or dialing`, async () => {
      const h = await harness(() => [PUBLIC])
      const reply = await exchange(h.proxy.port, request)
      assert.match(reply, new RegExp(`^HTTP/1\\.1 ${status} `, 'u'))
      assert.equal(h.decisions[0]?.outcome, outcome)
      assert.deepEqual(h.resolved, [])
      assert.deepEqual(h.dialed, [])
    })
  }

  for (const [label, answers] of [
    ['a private answer', ['10.0.0.5']],
    ['the metadata service', ['169.254.169.254']],
    ['loopback', ['127.0.0.1']],
    ['a mixed public and private answer', [PUBLIC, '192.168.1.10']],
    ['an IPv4-mapped IPv6 loopback', ['::ffff:127.0.0.1']],
    ['an IPv6 ULA', ['fd00::1']],
  ] as const) {
    it(`refuses ${label} and never dials`, async () => {
      const h = await harness(() => [...answers])
      const reply = await exchange(h.proxy.port, `CONNECT ${HOST}:443 HTTP/1.1\r\n${auth()}\r\n`)
      assert.match(reply, /^HTTP\/1\.1 403 /u)
      assert.deepEqual(h.decisions, [{ outcome: 'non-public', host: HOST }])
      assert.deepEqual(h.dialed, [])
    })
  }

  it('dials the vetted address, so a rebinding resolver cannot swap it', async () => {
    // First answer public, every later one private: only one lookup may happen.
    const h = await harness((_host, call) => (call === 0 ? [PUBLIC] : ['127.0.0.1']))
    await exchange(h.proxy.port, `CONNECT ${HOST}:443 HTTP/1.1\r\n${auth()}\r\n`, /\r\n\r\n/u)
    assert.deepEqual(h.resolved, [HOST])
    assert.deepEqual(h.dialed, [`${PUBLIC}:443`])
  })

  it('refuses a host that does not resolve', async () => {
    const h = await harness(() => [])
    const reply = await exchange(h.proxy.port, `CONNECT ${HOST}:443 HTTP/1.1\r\n${auth()}\r\n`)
    assert.match(reply, /^HTTP\/1\.1 502 /u)
    assert.deepEqual(h.dialed, [])
  })

  it('caps the tunnels one job may open', async () => {
    const h = await harness(() => [PUBLIC], { maxTunnels: 1 })
    await exchange(h.proxy.port, `CONNECT ${HOST}:443 HTTP/1.1\r\n${auth()}\r\n`, /\r\n\r\n/u)
    const second = await exchange(h.proxy.port, `CONNECT ${HOST}:443 HTTP/1.1\r\n${auth()}\r\n`)
    assert.match(second, /^HTTP\/1\.1 429 /u)
    assert.equal(h.dialed.length, 1)
  })

  it('refuses an oversized CONNECT head', async () => {
    const h = await harness(() => [PUBLIC])
    const reply = await exchange(
      h.proxy.port,
      `CONNECT ${HOST}:443 HTTP/1.1\r\nX-Pad: ${'a'.repeat(9000)}`,
    )
    assert.match(reply, /^HTTP\/1\.1 431 /u)
    assert.deepEqual(h.resolved, [])
  })

  it('refuses tunnel bytes sent before the 200', async () => {
    const h = await harness(() => [PUBLIC])
    const reply = await exchange(
      h.proxy.port,
      `CONNECT ${HOST}:443 HTTP/1.1\r\n${auth()}\r\n\x16\x03\x01`,
    )
    assert.match(reply, /^HTTP\/1\.1 400 /u)
    assert.deepEqual(h.dialed, [])
  })

  it('drops a slow-loris client that never finishes its head', async () => {
    const h = await harness(() => [PUBLIC], { headerTimeoutMs: 100 })
    const started = Date.now()
    const reply = await exchange(h.proxy.port, `CONNECT ${HOST}:443 HTTP/1.1\r\n`)
    assert.equal(reply, '')
    assert.ok(Date.now() - started < 2_000)
    assert.deepEqual(h.decisions, [{ outcome: 'malformed' }])
  })

  it('treats a SOCKS5 greeting on the same port as malformed', async () => {
    const h = await harness(() => [PUBLIC], { headerTimeoutMs: 100 })
    const reply = await exchange(h.proxy.port, Buffer.from([0x05, 0x01, 0x00]))
    assert.equal(reply, '')
    assert.deepEqual(h.dialed, [])
  })
})
