import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { EgressBroker } from './egress-broker.ts'
import { parseEgressRule } from './egress-rules.ts'

/**
 * The broker over a real unix socket, against a real TCP origin on loopback.
 * Everything a guest can do to it is one line of preamble, so that is what is
 * exercised: an admitted target, a refused one, a wildcard, and garbage.
 */

/** A TCP origin that upper-cases whatever it is sent, so bytes are provably relayed. */
function startEchoOrigin(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolveStart) => {
    const server: Server = createServer((socket) => {
      socket.on('data', (chunk: Buffer) => {
        socket.write(chunk.toString('utf8').toUpperCase())
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolveStart({
        port,
        close: (): void => {
          server.close()
        },
      })
    })
  })
}

/** Open the broker socket, send the preamble and one payload, collect the reply. */
function ask(
  socketPath: string,
  preamble: string,
  payload: string,
  waitMs = 300,
): Promise<{ reply: string; socket: Socket }> {
  return new Promise((resolveAsk) => {
    const socket = connect(socketPath)
    let received = ''
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8')
    })
    socket.once('connect', () => {
      socket.write(preamble)
      setTimeout(() => {
        socket.write(payload)
        setTimeout(() => {
          resolveAsk({ reply: received, socket })
        }, waitMs)
      }, 50)
    })
    socket.on('error', () => {
      resolveAsk({ reply: received, socket })
    })
  })
}

describe('EgressBroker', () => {
  let dir = ''
  let origin: { port: number; close: () => void }
  let broker: EgressBroker

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'copse-eb-'))
    origin = await startEchoOrigin()
    broker = new EgressBroker(dir, {
      rules: [
        parseEgressRule(`model.copse.internal:${String(origin.port)}`),
        parseEgressRule(`*.example.test:${String(origin.port)}`),
        parseEgressRule('*.example.test:443'),
      ],
      // Both names dial the loopback echo; only the allowlist tells them apart.
      resolve: {
        'model.copse.internal': '127.0.0.1',
        'api.example.test': '127.0.0.1',
        // The guest is told 443; the stand-in listens wherever it could.
        'tls.example.test': `127.0.0.1:${String(origin.port)}`,
      },
    })
    await broker.start()
  })

  after(async () => {
    await broker.stop()
    origin.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('relays bytes both ways for an admitted target and logs the connection', async () => {
    const { reply, socket } = await ask(
      broker.path(),
      `CONNECT model.copse.internal:${String(origin.port)}\n`,
      'hello',
    )
    socket.destroy()
    assert.ok(reply.startsWith('OK\n'), `expected OK, got ${JSON.stringify(reply)}`)
    assert.equal(reply.slice(3), 'HELLO')
    const connectEntry = broker
      .log()
      .find(
        (e) => e.event === 'connect' && e.origin === `model.copse.internal:${String(origin.port)}`,
      )
    assert.ok(connectEntry)
    assert.match(connectEntry.detail ?? '', /rule model\.copse\.internal/)
  })

  it('admits a subdomain through a wildcard rule', async () => {
    const { reply, socket } = await ask(
      broker.path(),
      `CONNECT api.example.test:${String(origin.port)}\n`,
      'wild',
    )
    socket.destroy()
    assert.ok(reply.startsWith('OK\n'), reply)
    assert.equal(reply.slice(3), 'WILD')
  })

  it('refuses a target no rule admits, and says so in the log', async () => {
    const { reply, socket } = await ask(
      broker.path(),
      `CONNECT github.com:${String(origin.port)}\n`,
      'never sent',
      100,
    )
    socket.destroy()
    assert.match(reply, /^DENY not in the allowlist\n/)
    const refused = broker.log().find((e) => e.event === 'refused')
    assert.ok(refused)
    assert.equal(refused.origin, `github.com:${String(origin.port)}`)
  })

  it('refuses the bare suffix of a wildcard and a sibling domain', async () => {
    for (const host of ['example.test', 'notexample.test', 'example.test.evil']) {
      const { reply, socket } = await ask(
        broker.path(),
        `CONNECT ${host}:${String(origin.port)}\n`,
        'x',
        100,
      )
      socket.destroy()
      assert.match(reply, /^DENY/, `${host} was admitted`)
    }
  })

  it('dials a remapped port while matching and logging the port the guest named', async () => {
    const { reply, socket } = await ask(broker.path(), 'CONNECT tls.example.test:443\n', 'remap')
    socket.destroy()
    assert.ok(reply.startsWith('OK\n'), reply)
    assert.equal(reply.slice(3), 'REMAP')
    const entry = broker
      .log()
      .find((e) => e.event === 'connect' && e.origin === 'tls.example.test:443')
    assert.ok(entry)
    assert.match(entry.detail ?? '', /rule \*\.example\.test:443/)
  })

  it('refuses a malformed preamble without dialling anything', async () => {
    const { reply, socket } = await ask(broker.path(), 'GET / HTTP/1.1\n', '', 100)
    socket.destroy()
    assert.match(reply, /^DENY malformed preamble/)
    assert.ok(broker.log().some((e) => e.event === 'refused' && e.detail === 'malformed preamble'))
  })
})
