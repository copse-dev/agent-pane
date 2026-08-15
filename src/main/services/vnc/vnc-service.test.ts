import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import type { SshExecResult, SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import type { SshConnection } from '../ssh-workspace/connection-manager.ts'
import { FakeSshTransport } from '../ssh-workspace/fake-ssh-transport.ts'
import {
  isPlausibleVncListener,
  resolveVncNetworkHost,
  VNC_DATA_CHANNEL,
  VNC_STATUS_CHANNEL,
  VncService,
} from './vnc-service.ts'

interface TestOwner {
  id: number
  destroyed: boolean
  events: Array<{ channel: string; args: unknown[] }>
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

function owner(id = 7): TestOwner {
  return {
    id,
    destroyed: false,
    events: [],
    isDestroyed(): boolean {
      return this.destroyed
    },
    send(channel: string, ...args: unknown[]): void {
      this.events.push({ channel, args })
    },
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
  return address.port
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for VNC test event')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

class ForwardingFakeTransport extends FakeSshTransport {
  closeCalls: number[] = []
  private readonly forwardedPort: number

  constructor(forwardedPort: number) {
    super()
    this.forwardedPort = forwardedPort
  }

  override async openForward(remotePort: number): Promise<{ localPort: number }> {
    assert.equal(remotePort, 5901)
    return Promise.resolve({ localPort: this.forwardedPort })
  }

  override async closeForward(localPort: number): Promise<void> {
    this.closeCalls.push(localPort)
    await Promise.resolve()
  }
}

class DiscoveringForwardingFakeTransport extends ForwardingFakeTransport {
  override async execArgv(argv: string[]): Promise<SshExecResult> {
    if (argv[0] === 'ss') {
      return Promise.resolve({
        stdout: 'LISTEN 0 16 127.0.0.1:5901 0.0.0.0:* users:(("x11vnc",pid=42,fd=3))',
        stderr: '',
        code: 0,
      })
    }
    return super.execArgv(argv)
  }
}

describe('VNC discovery candidates', () => {
  it('recognises conventional display ports and VNC process names', () => {
    assert.equal(
      isPlausibleVncListener({ port: 5900, pid: null, command: '', address: '127.0.0.1' }),
      true,
    )
    assert.equal(
      isPlausibleVncListener({
        port: 41_000,
        pid: 1,
        command: 'x11vnc',
        address: '127.0.0.1',
      }),
      true,
    )
    assert.equal(
      isPlausibleVncListener({ port: 3000, pid: 1, command: 'node', address: '127.0.0.1' }),
      false,
    )
  })

  it('accepts LAN addresses and pins LAN-only hostname resolution', async () => {
    assert.equal(await resolveVncNetworkHost('192.168.1.20'), '192.168.1.20')
    assert.equal(
      await resolveVncNetworkHost('studio.local', async () => [
        { address: 'fd00::20', family: 6 },
        { address: '192.168.1.20', family: 4 },
      ]),
      '192.168.1.20',
    )
  })

  it('rejects loopback, public, and mixed hostname resolution', async () => {
    await assert.rejects(() => resolveVncNetworkHost('127.0.0.1'), /private or link-local/)
    await assert.rejects(() => resolveVncNetworkHost('8.8.8.8'), /private or link-local/)
    await assert.rejects(
      () =>
        resolveVncNetworkHost('mixed.example', async () => [
          { address: '192.168.1.20', family: 4 },
          { address: '203.0.113.20', family: 4 },
        ]),
      /resolve only to private or link-local/,
    )
  })
})

describe('VncService', () => {
  const servers: Server[] = []

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => {
              resolve()
            })
          }),
      ),
    )
  })

  it('bridges loopback RFB bytes and enforces connection ownership', async () => {
    let received = Buffer.alloc(0)
    const server = createServer((socket) => {
      socket.on('data', (chunk: Buffer) => {
        received = Buffer.concat([received, chunk])
      })
      socket.write('RFB 003.008\n')
    })
    servers.push(server)
    const port = await listen(server)
    const service = new VncService()
    const firstOwner = owner()
    const connection = await service.open({ kind: 'loopback', port }, firstOwner)

    assert.equal(connection.status, 'connected')
    assert.equal(connection.writable, false)
    assert.equal(service.list(firstOwner.id).length, 1)
    assert.throws(() => {
      service.start(connection.id, 99)
    }, /Unknown VNC connection/)

    service.start(connection.id, firstOwner.id)
    await waitFor(() => firstOwner.events.some((event) => event.channel === VNC_DATA_CHANNEL))
    service.send(connection.id, firstOwner.id, new TextEncoder().encode('client hello'))
    await waitFor(() => received.toString().includes('client hello'))

    await service.close(connection.id, firstOwner.id)
    assert.equal(service.list().length, 0)
    assert.ok(firstOwner.events.some((event) => event.channel === VNC_STATUS_CHANNEL))
  })

  it('opens and cancels an SSH forward with the connection lifecycle', async () => {
    const server = createServer()
    servers.push(server)
    const port = await listen(server)
    const transport = new ForwardingFakeTransport(port)
    await transport.connect()
    const host: SshWorkspaceHost = {
      id: 'build-box',
      label: 'Build box',
      host: 'build.example',
    }
    const manager = {
      connect: async (hostId: string): Promise<SshConnection> => {
        assert.equal(hostId, host.id)
        return {
          host,
          transport,
          execArgv: (argv, options) => transport.execArgv(argv, options),
          execShell: (command, options) => transport.execShell(command, options),
        }
      },
    }
    const service = new VncService(manager)
    const firstOwner = owner()
    const connection = await service.open(
      { kind: 'ssh', hostId: host.id, remotePort: 5901 },
      firstOwner,
    )

    assert.equal(connection.localPort, port)
    await service.close(connection.id, firstOwner.id)
    assert.deepEqual(transport.closeCalls, [port])
  })

  it('discovers only verified local RFB listeners', async () => {
    const rfbServer = createServer((socket) => {
      socket.write('RFB 003.008\n')
    })
    const httpServer = createServer((socket) => {
      socket.write('HTTP/1.1 200 OK\r\n\r\n')
    })
    servers.push(rfbServer, httpServer)
    const rfbPort = await listen(rfbServer)
    const httpPort = await listen(httpServer)
    const service = new VncService(
      {
        connect: async (): Promise<SshConnection> => {
          throw new Error('SSH should not be used for local discovery')
        },
      },
      async () => ({
        tool: 'test',
        ports: [
          { port: rfbPort, pid: 1, command: 'x11vnc', address: '127.0.0.1' },
          { port: httpPort, pid: 2, command: 'wayvnc', address: '127.0.0.1' },
          { port: 5902, pid: 3, command: 'x11vnc', address: '192.0.2.10' },
          { port: 3000, pid: 4, command: 'node', address: '127.0.0.1' },
        ],
      }),
    )

    assert.deepEqual(await service.discover({ kind: 'local' }), [rfbPort])
  })

  it('discovers remote RFB listeners through temporary SSH forwards', async () => {
    const server = createServer((socket) => {
      socket.write('RFB 003.008\n')
    })
    servers.push(server)
    const port = await listen(server)
    const transport = new DiscoveringForwardingFakeTransport(port)
    await transport.connect()
    const host: SshWorkspaceHost = {
      id: 'build-box',
      label: 'Build box',
      host: 'build.example',
    }
    const manager = {
      connect: async (hostId: string): Promise<SshConnection> => {
        assert.equal(hostId, host.id)
        return {
          host,
          transport,
          execArgv: (argv) => transport.execArgv(argv),
          execShell: (command, options) => transport.execShell(command, options),
        }
      },
    }
    const service = new VncService(manager)

    assert.deepEqual(await service.discover({ kind: 'ssh', hostId: host.id }), [5901])
    assert.deepEqual(transport.closeCalls, [port])
  })

  it('returns nearby DNS-SD services from the discovery provider', async () => {
    const nearby = {
      name: 'Studio Mac',
      host: 'studio.local',
      port: 5900,
      addresses: ['192.168.1.20'],
    }
    const service = new VncService(undefined, undefined, async () => [nearby])

    assert.deepEqual(await service.discoverNearby(), [nearby])
  })

  it('opens an explicitly confirmed direct-network target at its pinned address', async () => {
    const server = createServer()
    servers.push(server)
    const port = await listen(server)
    const service = new VncService(undefined, undefined, undefined, async (host) => {
      assert.equal(host, 'studio.local')
      return '127.0.0.1'
    })
    const firstOwner = owner()

    const connection = await service.open(
      { kind: 'network', host: 'studio.local', port, confirmedUnencrypted: true },
      firstOwner,
    )

    assert.equal(connection.target.kind, 'network')
    await service.close(connection.id, firstOwner.id)
  })

  it('reports a refused server distinctly from tunnel setup', async () => {
    const probe = createServer()
    const unusedPort = await listen(probe)
    await new Promise<void>((resolve) =>
      probe.close(() => {
        resolve()
      }),
    )
    const service = new VncService()
    await assert.rejects(
      () => service.open({ kind: 'loopback', port: unusedPort }, owner()),
      /No VNC server answered on 127\.0\.0\.1/,
    )
  })

  it('explains how to enable Screen Sharing when a LAN Mac refuses VNC', async () => {
    const probe = createServer()
    const unusedPort = await listen(probe)
    await new Promise<void>((resolve) => {
      probe.close(() => {
        resolve()
      })
    })
    const service = new VncService(undefined, undefined, undefined, async () => '127.0.0.1')

    await assert.rejects(
      () =>
        service.open(
          {
            kind: 'network',
            host: 'studio.local',
            port: unusedPort,
            confirmedUnencrypted: true,
          },
          owner(),
        ),
      /Turn on General → Sharing → Screen Sharing.*allow VNC viewers/,
    )
  })
})
