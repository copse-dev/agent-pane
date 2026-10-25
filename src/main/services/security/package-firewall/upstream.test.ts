import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer, type IncomingMessage } from 'node:http'
import {
  connect as netConnect,
  createServer as createNetServer,
  type Server,
  type Socket,
} from 'node:net'
import type { Duplex } from 'node:stream'
import { connectUpstream, hostBypassesProxy, upstreamConfigFromEnv } from './upstream.ts'

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
  return address.port
}

describe('hostBypassesProxy', () => {
  it('follows curl-style NO_PROXY matching', () => {
    assert.equal(hostBypassesProxy('anything.test', 443, ['*']), true)
    assert.equal(hostBypassesProxy('registry.npmjs.org', 443, ['registry.npmjs.org']), true)
    assert.equal(hostBypassesProxy('registry.npmjs.org', 443, ['npmjs.org']), true)
    assert.equal(hostBypassesProxy('registry.npmjs.org', 443, ['.npmjs.org']), true)
    assert.equal(hostBypassesProxy('registry.npmjs.org', 443, ['*.npmjs.org']), true)
    assert.equal(hostBypassesProxy('notnpmjs.org', 443, ['npmjs.org']), false)
    assert.equal(hostBypassesProxy('crates.io', 443, ['static.crates.io']), false)
  })

  it('honours a port when the entry names one', () => {
    assert.equal(hostBypassesProxy('example.com', 8443, ['example.com:8443']), true)
    assert.equal(hostBypassesProxy('example.com', 443, ['example.com:8443']), false)
  })

  it('matches IP literals against CIDR entries only', () => {
    assert.equal(hostBypassesProxy('10.1.2.3', 443, ['10.0.0.0/8']), true)
    assert.equal(hostBypassesProxy('11.1.2.3', 443, ['10.0.0.0/8']), false)
    assert.equal(hostBypassesProxy('[::1]', 443, ['::1']), true)
    assert.equal(hostBypassesProxy('10.example.com', 443, ['10.0.0.0/8']), false)
  })
})

describe('upstreamConfigFromEnv', () => {
  it('prefers HTTPS_PROXY and reads NO_PROXY', () => {
    const config = upstreamConfigFromEnv({
      HTTPS_PROXY: 'http://user:p%40ss@proxy.corp:3128',
      https_proxy: 'http://ignored:1',
      NO_PROXY: 'localhost, .corp',
    })
    assert.equal(config.proxy?.host, 'proxy.corp:3128')
    assert.deepEqual(config.noProxy, ['localhost', '.corp'])
  })

  it('accepts a scheme-less proxy and ignores SOCKS and empty values', () => {
    assert.equal(upstreamConfigFromEnv({ https_proxy: 'proxy:8080' }).proxy?.host, 'proxy:8080')
    assert.equal(
      upstreamConfigFromEnv({ HTTPS_PROXY: '', ALL_PROXY: 'socks5://s:1080' }).proxy,
      null,
    )
  })
})

describe('connectUpstream', () => {
  function readAll(socket: Socket): Promise<string> {
    return new Promise((resolve, reject) => {
      let text = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        text += chunk
      })
      socket.once('end', () => {
        resolve(text)
      })
      socket.once('error', reject)
    })
  }

  async function startTarget(reply: string): Promise<{ port: number; server: Server }> {
    const server = createNetServer((socket) => {
      socket.end(reply)
    })
    return { port: await listen(server), server }
  }

  it('opens a CONNECT tunnel through the user proxy with its credentials', async () => {
    const target = await startTarget('hello from target')
    const seen: { url: string; auth: string | undefined }[] = []
    const userProxy = createHttpServer()
    userProxy.on('connect', (request: IncomingMessage, client: Duplex) => {
      seen.push({ url: request.url ?? '', auth: request.headers['proxy-authorization'] })
      const upstream = netConnect({ host: '127.0.0.1', port: target.port }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.pipe(client)
        client.pipe(upstream)
      })
    })
    const proxyPort = await listen(userProxy)
    try {
      const socket = await connectUpstream('target.test', 443, {
        proxy: new URL(`http://me:s%40cret@127.0.0.1:${String(proxyPort)}`),
        noProxy: [],
      })
      assert.equal(await readAll(socket), 'hello from target')
      assert.deepEqual(seen, [
        { url: 'target.test:443', auth: `Basic ${Buffer.from('me:s@cret').toString('base64')}` },
      ])
    } finally {
      userProxy.close()
      target.server.close()
    }
  })

  it('connects directly when NO_PROXY matches the target', async () => {
    const target = await startTarget('direct')
    try {
      const socket = await connectUpstream('127.0.0.1', target.port, {
        proxy: new URL('http://127.0.0.1:9'),
        noProxy: ['127.0.0.1'],
      })
      assert.equal(await readAll(socket), 'direct')
    } finally {
      target.server.close()
    }
  })

  it('rejects when the user proxy refuses the tunnel', async () => {
    const userProxy = createHttpServer()
    userProxy.on('connect', (_request: IncomingMessage, client: Duplex) => {
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
    })
    const proxyPort = await listen(userProxy)
    try {
      await assert.rejects(
        connectUpstream('blocked.test', 443, {
          proxy: new URL(`http://127.0.0.1:${String(proxyPort)}`),
          noProxy: [],
        }),
        /refused CONNECT blocked\.test:443 \(403\)/,
      )
    } finally {
      userProxy.close()
    }
  })
})
