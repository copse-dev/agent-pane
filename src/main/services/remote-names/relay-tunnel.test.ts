import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { connect, type ConnectionOptions, type TLSSocket } from 'node:tls'
import { generateDeviceKeyPair, signText } from '@copse/remote-protocol/keys.ts'
import { createTestCa, testServerIdentity } from '../../../../tests/helpers/test-certificates.ts'
import { startFakeRelay, type FakeRelay } from '../../../../tests/helpers/fake-relay.ts'
import { createRelayIngress, type RelayIngress } from '../mobile/relay-ingress.ts'
import {
  parseRelayEndpoint,
  relayBackoffMs,
  RelayTunnel,
  type RelayTunnelStatus,
} from './relay-tunnel.ts'

const label = 'abcdefgh2345'
const webHost = `web.${label}.u.copse.me`

function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (check()) resolve()
      else if (Date.now() - started > timeoutMs) reject(new Error('condition never held'))
      else setTimeout(tick, 10)
    }
    tick()
  })
}

describe('relay endpoint', () => {
  it('reads host and optional port, defaulting to 443', () => {
    assert.deepEqual(parseRelayEndpoint('relay.copse.dev'), { host: 'relay.copse.dev', port: 443 })
    assert.deepEqual(parseRelayEndpoint(' Relay.Example.test:8443 '), {
      host: 'relay.example.test',
      port: 8443,
    })
  })
  it('refuses IP literals, which a ClientHello never names, and malformed input', () => {
    for (const value of ['127.0.0.1', '127.0.0.1:443', 'https://relay.copse.dev', 'a b', '', 'x:0'])
      assert.equal(parseRelayEndpoint(value), null, value)
  })
})

describe('relay backoff', () => {
  it('doubles from a second to five minutes with bounded jitter', () => {
    assert.equal(
      relayBackoffMs(1, () => 0.5),
      1000,
    )
    assert.equal(
      relayBackoffMs(4, () => 0.5),
      8000,
    )
    assert.equal(
      relayBackoffMs(40, () => 0.5),
      300_000,
    )
    assert.equal(
      relayBackoffMs(1, () => 0),
      800,
    )
    assert.equal(
      relayBackoffMs(1, () => 1),
      1200,
    )
  })
})

describe('RelayTunnel', () => {
  const deviceCa = createTestCa('Device test CA')
  const deviceIdentity = testServerIdentity(deviceCa, [`*.${label}.u.copse.me`])
  const cleanups: (() => Promise<void> | void)[] = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  interface Fixture {
    relay: FakeRelay
    tunnel: RelayTunnel
    statuses: RelayTunnelStatus[]
    seen: { ip: string; host: string | undefined }[]
  }

  async function setup(
    options: { wrongKey?: boolean; random?: () => number } = {},
  ): Promise<Fixture> {
    const keys = await generateDeviceKeyPair()
    const other = await generateDeviceKeyPair()
    const relay = await startFakeRelay({
      deviceKey: (name) =>
        Promise.resolve(name === label ? (options.wrongKey ? other : keys).publicKey : null),
    })
    cleanups.push(() => relay.close())
    const seen: Fixture['seen'] = []
    const ingress: RelayIngress = createRelayIngress({
      identity: () => ({
        hostname: `lan.${label}.u.copse.me`,
        web: webHost,
        key: deviceIdentity.key,
        cert: deviceIdentity.cert,
      }),
      handle: (req, res, clientIp) => {
        seen.push({ ip: clientIp, host: req.headers.host })
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end(`relayed ${req.method ?? ''} ${req.url ?? ''}`)
      },
    })
    cleanups.push(() => {
      ingress.close()
    })
    const statuses: RelayTunnelStatus[] = []
    const tunnel = new RelayTunnel({
      endpoint: { host: relay.hostname, port: relay.port },
      label,
      sign: (text): Promise<string> => signText(keys.privateKey, text),
      onStream: (stream, clientIp): void => {
        ingress.accept(stream, clientIp)
      },
      onStatus: (status): void => {
        statuses.push(status)
      },
      // The boundary to the network: only the address and the trusted root
      // differ from production, never the server name the relay routes on.
      connect: (connection: ConnectionOptions): TLSSocket =>
        connect({ ...connection, host: '127.0.0.1', ca: relay.caPem }),
      ...(options.random ? { random: options.random } : {}),
    })
    cleanups.push(() => {
      tunnel.stop()
    })
    return { relay, tunnel, statuses, seen }
  }

  async function connected(fixture: Fixture): Promise<void> {
    fixture.tunnel.start()
    await fixture.relay.waitForTunnel()
    await until(() => fixture.tunnel.status().state === 'connected')
  }

  it('authenticates with the device key and serves a browser end to end', async () => {
    const fixture = await setup()
    await connected(fixture)
    assert.deepEqual(fixture.relay.authenticated, [label])
    assert.deepEqual(
      fixture.statuses.map((status) => status.state),
      ['connecting', 'connected'],
    )

    // The browser verifies the Mac's own certificate: the relay only carried bytes.
    const response = await fixture.relay.browserRequest({
      serverName: webHost,
      ca: deviceCa.pem,
      path: '/api/activity',
      clientIp: '198.51.100.23',
    })
    assert.equal(response.status, 200)
    assert.equal(response.body, 'relayed GET /api/activity')
    assert.deepEqual(fixture.seen, [{ ip: '198.51.100.23', host: webHost }])
  })

  it('refuses streams that are not CONNECT for its own web name with a client address', async () => {
    const fixture = await setup()
    await connected(fixture)
    const refusedStreams = [
      { authority: 'web.zzzzzzzzzzzz.u.copse.me:443', clientIp: '198.51.100.1' },
      { authority: `lan.${label}.u.copse.me:443`, clientIp: '198.51.100.1' },
      { authority: `${webHost}:443` },
      { authority: `${webHost}:443`, clientIp: 'not-an-ip' },
    ]
    for (const headers of refusedStreams) {
      const { status } = await fixture.relay.openStream(headers)
      assert.equal(status, null, JSON.stringify(headers))
    }
    // The tunnel survives refused streams.
    assert.equal(fixture.tunnel.status().state, 'connected')
    assert.deepEqual(fixture.seen, [])
  })

  it('reports a refused handshake and keeps retrying with backoff', async () => {
    const fixture = await setup({ wrongKey: true, random: () => 0 })
    fixture.tunnel.start()
    await until(() => fixture.tunnel.status().state === 'retrying')
    const status = fixture.tunnel.status()
    assert.match(status.error ?? '', /refused this Mac/)
    assert.ok(status.retryAt !== null)
    assert.deepEqual(fixture.relay.refused, ['signature does not verify'])
    await until(() => fixture.relay.refused.length >= 2, 5000)
    assert.equal(fixture.relay.tunnels(), 0)
  })

  it('reconnects after the relay drops the tunnel', async () => {
    const fixture = await setup({ random: () => 0 })
    await connected(fixture)
    fixture.relay.dropTunnels()
    await until(() => fixture.tunnel.status().state === 'retrying')
    await until(() => fixture.tunnel.status().state === 'connected', 5000)
    assert.deepEqual(fixture.relay.authenticated, [label, label])
  })

  it('stops for good: no reconnect after stop', async () => {
    const fixture = await setup({ random: () => 0 })
    await connected(fixture)
    // Any reconnect is scheduled with setTimeout: run the clock past the longest backoff.
    mock.timers.enable({ apis: ['setTimeout'] })
    cleanups.push(() => {
      mock.timers.reset()
    })
    fixture.tunnel.stop()
    assert.equal(fixture.tunnel.status().state, 'stopped')
    // Let the closed socket's events run first, so a reconnect they schedule is ticked too.
    for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve))
    mock.timers.tick(10 * 60_000)
    // A reconnect would have set `connecting` synchronously.
    assert.equal(fixture.tunnel.status().state, 'stopped')
    assert.equal(fixture.statuses.at(-1)?.state, 'stopped')
    assert.deepEqual(fixture.relay.authenticated, [label])
  })

  it('names the relay when it cannot be reached', async () => {
    const keys = await generateDeviceKeyPair()
    const tunnel = new RelayTunnel({
      endpoint: { host: 'relay.copse.test', port: 1 },
      label,
      sign: (text): Promise<string> => signText(keys.privateKey, text),
      onStream: (stream): void => {
        stream.destroy()
      },
      onStatus: (): void => {},
      connect: (connection: ConnectionOptions): TLSSocket =>
        connect({ ...connection, host: '127.0.0.1' }),
    })
    cleanups.push(() => {
      tunnel.stop()
    })
    tunnel.start()
    await until(() => tunnel.status().state === 'retrying')
    assert.match(tunnel.status().error ?? '', /Could not reach relay\.copse\.test/)
  })
})

describe('relay ingress', () => {
  it('closes a relayed connection when this Mac has no valid certificate', async () => {
    const { PassThrough } = await import('node:stream')
    let handled = false
    const ingress = createRelayIngress({
      identity: () => null,
      handle: () => {
        handled = true
      },
    })
    const stream = new PassThrough()
    ingress.accept(stream, '198.51.100.2')
    assert.equal(stream.destroyed, true)
    assert.equal(ingress.connections(), 0)
    assert.equal(handled, false)
    ingress.close()
  })
})
