import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import type { SshConnection } from '../ssh-workspace/connection-manager.ts'
import { FakeSshTransport } from '../ssh-workspace/fake-ssh-transport.ts'
import { VNC_DATA_CHANNEL, VNC_STATUS_CHANNEL, VncService } from './vnc-service.ts'

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
})
