import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import { PassThrough } from 'node:stream'
import { EgressBroker } from './egress-broker.ts'
import { EgressLink, type MuxStream } from './egress-link.ts'
import { parseEgressRule } from './egress-rules.ts'

/**
 * The broker over an in-memory link — two byte streams crossed, exactly the
 * shape the attached container's stdio has — against a real TCP origin on
 * loopback. Everything a guest can do to it is one `OPEN host:port`, so that
 * is what is exercised: an admitted target, a refused one, a wildcard, and
 * garbage.
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

/** Open `target` from the guest end, send one payload, collect what came back. */
async function ask(
  guest: EgressLink,
  target: string,
  payload: string,
  waitMs = 300,
): Promise<{ stream: MuxStream; reply: string } | { refused: string }> {
  let stream: MuxStream
  try {
    stream = await guest.open(target)
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) }
  }
  let received = ''
  stream.on('data', (chunk: Buffer) => {
    received += chunk.toString('utf8')
  })
  stream.on('error', () => {
    // The assertion reads what arrived before the error.
  })
  if (payload.length > 0) stream.write(payload)
  await new Promise((resolveWait) => setTimeout(resolveWait, waitMs))
  return { stream, reply: received }
}

describe('EgressBroker', () => {
  let origin: { port: number; close: () => void }
  let broker: EgressBroker
  let guest: EgressLink

  before(async () => {
    origin = await startEchoOrigin()
    broker = new EgressBroker({
      rules: [
        parseEgressRule(`model.copse.internal:${String(origin.port)}`),
        parseEgressRule(`*.example.test:${String(origin.port)}`),
        parseEgressRule('*.example.test:443'),
        parseEgressRule('unreachable.example.test:9'),
      ],
      // Both names dial the loopback echo; only the allowlist tells them apart.
      resolve: {
        'model.copse.internal': '127.0.0.1',
        'api.example.test': '127.0.0.1',
        // The guest is told 443; the stand-in listens wherever it could.
        'tls.example.test': `127.0.0.1:${String(origin.port)}`,
        // Allowed, and nothing listens there.
        'unreachable.example.test': '127.0.0.1:9',
      },
    })
    const guestToHost = new PassThrough()
    const hostToGuest = new PassThrough()
    broker.attach(guestToHost, hostToGuest)
    guest = new EgressLink(hostToGuest, guestToHost)
  })

  after(() => {
    broker.stop()
    origin.close()
  })

  it('relays bytes both ways for an admitted target and logs the connection', async () => {
    const answer = await ask(guest, `model.copse.internal:${String(origin.port)}`, 'hello')
    assert.ok('stream' in answer, `refused: ${'refused' in answer ? answer.refused : ''}`)
    answer.stream.destroy()
    assert.equal(answer.reply, 'HELLO')
    const connectEntry = broker
      .log()
      .find(
        (e) => e.event === 'connect' && e.origin === `model.copse.internal:${String(origin.port)}`,
      )
    assert.ok(connectEntry)
    assert.match(connectEntry.detail ?? '', /rule model\.copse\.internal/)
  })

  it('admits a subdomain through a wildcard rule', async () => {
    const answer = await ask(guest, `api.example.test:${String(origin.port)}`, 'wild')
    assert.ok('stream' in answer)
    answer.stream.destroy()
    assert.equal(answer.reply, 'WILD')
  })

  it('refuses a target no rule admits, and says so in the log', async () => {
    const answer = await ask(guest, `github.com:${String(origin.port)}`, 'never sent', 50)
    assert.ok('refused' in answer)
    assert.match(answer.refused, /^DENY not in the allowlist$/)
    const refused = broker.log().find((e) => e.event === 'refused')
    assert.ok(refused)
    assert.equal(refused.origin, `github.com:${String(origin.port)}`)
  })

  it('refuses the bare suffix of a wildcard and a sibling domain', async () => {
    for (const host of ['example.test', 'notexample.test', 'example.test.evil']) {
      const answer = await ask(guest, `${host}:${String(origin.port)}`, 'x', 50)
      assert.ok('refused' in answer, `${host} was admitted`)
      assert.match(answer.refused, /^DENY/)
    }
  })

  it('dials a remapped port while matching and logging the port the guest named', async () => {
    const answer = await ask(guest, 'tls.example.test:443', 'remap')
    assert.ok('stream' in answer)
    answer.stream.destroy()
    assert.equal(answer.reply, 'REMAP')
    const entry = broker
      .log()
      .find((e) => e.event === 'connect' && e.origin === 'tls.example.test:443')
    assert.ok(entry)
    assert.match(entry.detail ?? '', /rule \*\.example\.test:443/)
  })

  it('refuses a malformed request without dialling anything', async () => {
    const answer = await ask(guest, 'GET / HTTP/1.1', '', 50)
    assert.ok('refused' in answer)
    assert.match(answer.refused, /^DENY malformed request/)
    assert.ok(broker.log().some((e) => e.event === 'refused' && e.detail === 'malformed request'))
  })

  it('refuses, with the dial error, an allowed origin that does not answer', async () => {
    const answer = await ask(guest, 'unreachable.example.test:9', '', 50)
    assert.ok('refused' in answer)
    assert.match(answer.refused, /^DENY origin unreachable: connect ECONNREFUSED/)
    const entry = broker
      .log()
      .find((e) => e.event === 'error' && e.origin === 'unreachable.example.test:9')
    assert.ok(entry)
    assert.match(entry.detail ?? '', /^origin: connect ECONNREFUSED/)
  })

  it('answers a probe and logs nothing for it', async () => {
    const before = broker.log().length
    await guest.ping(500)
    assert.equal(broker.log().length, before)
  })

  it('records the bytes each way when the guest closes an admitted stream', async () => {
    const answer = await ask(guest, `model.copse.internal:${String(origin.port)}`, 'count me')
    assert.ok('stream' in answer)
    answer.stream.end()
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    answer.stream.destroy()
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    const closes = broker
      .log()
      .filter(
        (e) => e.event === 'close' && e.origin === `model.copse.internal:${String(origin.port)}`,
      )
    const last = closes.at(-1)
    assert.ok(last)
    assert.equal(last.bytesToOrigin, 'count me'.length)
    assert.equal(last.bytesFromOrigin, 'COUNT ME'.length)
  })
})
