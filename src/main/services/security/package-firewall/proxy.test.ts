import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import {
  Agent as HttpsAgent,
  createServer as createHttpsServer,
  request as httpsRequest,
} from 'node:https'
import {
  connect as netConnect,
  createServer as createNetServer,
  type Server,
  type Socket,
} from 'node:net'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect } from 'node:tls'
import type { PackageVerdict } from './advisories.ts'
import {
  startPackageFirewallProxy,
  type FirewallDecision,
  type RunningFirewallProxy,
} from './proxy.ts'
import { INTERCEPTED_REGISTRY_HOSTS, type PackageCoordinates } from './registry-targets.ts'
import { createCertificateAuthority } from './x509.ts'

const TOKEN = 'invocation-token'
const AUTH = `Basic ${Buffer.from(`copse:${TOKEN}`).toString('base64')}`

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
  return address.port
}

/** CONNECT through the firewall, the way npm/pip/cargo open a tunnel. */
function connectVia(
  proxyPort: number,
  authority: string,
  auth: string | null,
): Promise<{ status: number; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: authority,
      headers: auth === null ? {} : { 'proxy-authorization': auth },
    })
    request.once('connect', (response, socket) => {
      resolve({ status: response.statusCode ?? 0, socket })
    })
    request.once('error', reject)
    request.end()
  })
}

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function getOverTls(socket: Socket, host: string, path: string, ca: string): Promise<Reply> {
  const secure = tlsConnect({ socket, servername: host, ca })
  return new Promise((resolve, reject) => {
    const request = httpsRequest({ host, path, createConnection: () => secure })
    request.once('response', (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        body += chunk
      })
      response.once('end', () => {
        secure.destroy()
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body })
      })
    })
    request.once('error', reject)
    request.end()
  })
}

describe('package firewall proxy', () => {
  const firewallCa = createCertificateAuthority({
    permittedHosts: [...INTERCEPTED_REGISTRY_HOSTS.keys()],
  })
  const registryCa = createCertificateAuthority({ permittedHosts: ['registry.npmjs.org'] })
  const registryRequests: { path: string; headers: IncomingHttpHeaders }[] = []
  const tunnels: string[] = []
  const decisions: FirewallDecision[] = []
  const unreachable: string[] = []
  let registry: Server
  let echo: Server
  let proxy: RunningFirewallProxy

  before(async () => {
    const leaf = registryCa.issue('registry.npmjs.org')
    registry = createHttpsServer({ cert: leaf.certPem, key: leaf.keyPem }, (request, response) => {
      registryRequests.push({ path: request.url ?? '', headers: request.headers })
      if (request.url === '/slow') {
        // Answers only after the client has given up.
        setTimeout(() => response.end('late'), 300).unref()
        return
      }
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(`registry:${request.url ?? ''}`)
    })
    const registryPort = await listen(registry)
    echo = createNetServer((socket) => socket.pipe(socket))
    const echoPort = await listen(echo)

    // Stands in for the real registry and the user's network: both point at local servers.
    class LocalRegistryAgent extends HttpsAgent {
      override createConnection(): Duplex {
        return tlsConnect({
          host: '127.0.0.1',
          port: registryPort,
          servername: 'registry.npmjs.org',
          ca: registryCa.certPem,
        })
      }
    }
    proxy = await startPackageFirewallProxy({
      authority: firewallCa,
      token: TOKEN,
      check: (pkg: PackageCoordinates): Promise<PackageVerdict> =>
        Promise.resolve(
          pkg.name === 'evil'
            ? { status: 'blocked', advisories: ['MAL-2026-1'] }
            : { status: 'allowed', advisories: [] },
        ),
      connectTunnel: (host, port) => {
        tunnels.push(`${host}:${String(port)}`)
        if (host === 'down.test') return Promise.reject(new Error('connect ENETUNREACH'))
        return new Promise((resolve, reject) => {
          const socket = netConnect({ host: '127.0.0.1', port: echoPort }, () => {
            resolve(socket)
          })
          socket.once('error', reject)
        })
      },
      registryAgent: new LocalRegistryAgent(),
      onDecision: (decision) => decisions.push(decision),
      onUnreachable: (host, error) => unreachable.push(`${host}: ${error.message}`),
    })
  })

  after(async () => {
    await proxy.close()
    registry.close()
    echo.close()
  })

  beforeEach(() => {
    registryRequests.length = 0
    tunnels.length = 0
    decisions.length = 0
    unreachable.length = 0
  })

  it('advertises its credentials in the proxy URL', () => {
    assert.equal(proxy.url, `http://copse:${TOKEN}@127.0.0.1:${String(proxy.port)}`)
  })

  it('forwards an allowed tarball to the registry and records the decision', async () => {
    const { status, socket } = await connectVia(proxy.port, 'registry.npmjs.org:443', AUTH)
    assert.equal(status, 200)
    const reply = await getOverTls(
      socket,
      'registry.npmjs.org',
      '/lodash/-/lodash-4.17.21.tgz',
      firewallCa.certPem,
    )
    assert.equal(reply.status, 200)
    assert.equal(reply.body, 'registry:/lodash/-/lodash-4.17.21.tgz')
    assert.deepEqual(
      decisions.map((decision) => [decision.pkg.name, decision.verdict.status]),
      [['lodash', 'allowed']],
    )
    const [seen] = registryRequests
    assert.equal(seen?.headers.host, 'registry.npmjs.org')
    assert.equal(seen.headers['proxy-authorization'], undefined)
  })

  it('answers 403 for a listed tarball without contacting the registry', async () => {
    const { socket } = await connectVia(proxy.port, 'registry.npmjs.org:443', AUTH)
    const reply = await getOverTls(
      socket,
      'registry.npmjs.org',
      '/evil/-/evil-1.0.0.tgz',
      firewallCa.certPem,
    )
    assert.equal(reply.status, 403)
    assert.match(reply.body, /Blocked npm package evil@1\.0\.0: listed as malicious/)
    assert.match(reply.body, /MAL-2026-1/)
    assert.deepEqual(registryRequests, [])
  })

  it('intercepts a registry named with a trailing dot instead of tunnelling it', async () => {
    const { status, socket } = await connectVia(proxy.port, 'registry.npmjs.org.:443', AUTH)
    assert.equal(status, 200)
    const reply = await getOverTls(
      socket,
      'registry.npmjs.org',
      '/evil/-/evil-1.0.0.tgz',
      firewallCa.certPem,
    )
    assert.equal(reply.status, 403)
    assert.deepEqual(tunnels, [])
    assert.deepEqual(registryRequests, [])
  })

  it('passes metadata through without a check', async () => {
    const { socket } = await connectVia(proxy.port, 'registry.npmjs.org:443', AUTH)
    const reply = await getOverTls(socket, 'registry.npmjs.org', '/evil', firewallCa.certPem)
    assert.equal(reply.status, 200)
    assert.deepEqual(decisions, [])
  })

  it('refuses a CONNECT without the invocation token', async () => {
    for (const auth of [null, `Basic ${Buffer.from('copse:wrong').toString('base64')}`]) {
      const { status, socket } = await connectVia(proxy.port, 'example.com:443', auth)
      socket.destroy()
      assert.equal(status, 407)
    }
    assert.deepEqual(tunnels, [])
  })

  it('tunnels other hosts byte-for-byte without intercepting them', async () => {
    const { status, socket } = await connectVia(proxy.port, 'example.com:443', AUTH)
    assert.equal(status, 200)
    socket.write('raw bytes')
    const echoed = await new Promise<string>((resolve) => {
      socket.once('data', (chunk: Buffer) => {
        resolve(chunk.toString())
      })
    })
    socket.destroy()
    assert.equal(echoed, 'raw bytes')
    assert.deepEqual(tunnels, ['example.com:443'])
  })

  it('answers 502 and reports a host it cannot reach', async () => {
    const { status, socket } = await connectVia(proxy.port, 'down.test:443', AUTH)
    socket.destroy()
    assert.equal(status, 502)
    assert.deepEqual(unreachable, ['down.test: connect ENETUNREACH'])
  })

  it('does not report a registry unreachable when the client gives up first', async () => {
    const { socket } = await connectVia(proxy.port, 'registry.npmjs.org:443', AUTH)
    const secure = tlsConnect({ socket, servername: 'registry.npmjs.org', ca: firewallCa.certPem })
    await new Promise<void>((resolve) => {
      secure.once('secureConnect', () => {
        secure.write('GET /slow HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n')
        resolve()
      })
    })
    // Let the proxy forward the request before the client hangs up.
    while (!registryRequests.some((request) => request.path === '/slow')) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    secure.destroy()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(unreachable, [])
  })

  it('checks absolute-form plain-HTTP downloads too', async () => {
    const reply = await new Promise<Reply>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: proxy.port,
        path: 'http://registry.npmjs.org/evil/-/evil-1.0.0.tgz',
        headers: { 'proxy-authorization': AUTH },
      })
      request.once('response', (response) => {
        let body = ''
        response.on('data', (chunk: Buffer) => {
          body += chunk.toString()
        })
        response.once('end', () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body })
        })
      })
      request.once('error', reject)
      request.end()
    })
    assert.equal(reply.status, 403)
    assert.deepEqual(tunnels, [])
  })
})
