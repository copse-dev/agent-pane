import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { EgressLink, FRAME, FrameReader, encodeFrame, type MuxStream } from './egress-link.ts'

/**
 * The link on its own: framing survives arbitrary splits, a stream carries
 * bytes both ways and closes cleanly, a refusal reaches the opener, a reset
 * reaches the peer, and a severed byte stream fails everything on it.
 */

function pair(): {
  guest: EgressLink
  host: EgressLink
  opened: Array<{ id: number; target: string }>
} {
  const guestToHost = new PassThrough()
  const hostToGuest = new PassThrough()
  const opened: Array<{ id: number; target: string }> = []
  const host = new EgressLink(guestToHost, hostToGuest, {
    onOpen: (id, target): void => {
      opened.push({ id, target })
    },
  })
  const guest = new EgressLink(hostToGuest, guestToHost)
  return { guest, host, opened }
}

function collect(stream: MuxStream): { text: () => string; ended: () => boolean } {
  let text = ''
  let ended = false
  stream.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8')
  })
  stream.on('end', () => {
    ended = true
  })
  return { text: () => text, ended: () => ended }
}

const tick = (ms = 20): Promise<void> => new Promise((resolveTick) => setTimeout(resolveTick, ms))

describe('egress link framing', () => {
  it('reassembles frames from any split of the bytes', () => {
    const frames = [
      encodeFrame(1, FRAME.OPEN, 'api.example.test:443'),
      encodeFrame(1, FRAME.DATA, Buffer.alloc(3000, 0x61)),
      encodeFrame(0, FRAME.PING),
      encodeFrame(1, FRAME.END),
    ]
    const wire = Buffer.concat(frames)
    for (const step of [1, 7, 64, 1024, wire.length]) {
      const reader = new FrameReader()
      const out = []
      for (let at = 0; at < wire.length; at += step) {
        out.push(...reader.feed(wire.subarray(at, at + step)))
      }
      assert.deepEqual(
        out.map((f) => [f.id, f.type, f.payload.length]),
        [
          [1, FRAME.OPEN, 20],
          [1, FRAME.DATA, 3000],
          [0, FRAME.PING, 0],
          [1, FRAME.END, 0],
        ],
        `step ${String(step)}`,
      )
      assert.equal(out[0]?.payload.toString('utf8'), 'api.example.test:443')
    }
  })

  it('refuses a frame that claims an absurd length', () => {
    const header = Buffer.alloc(9)
    header.writeUInt32BE(1, 0)
    header.writeUInt8(FRAME.DATA, 4)
    header.writeUInt32BE(0xffffffff, 5)
    assert.throws(() => new FrameReader().feed(header), /frame too large/)
  })
})

describe('egress link streams', () => {
  it('carries bytes both ways and half-closes each direction on its own', async () => {
    const { guest, host, opened } = pair()
    const opening = guest.open('api.example.test:443')
    await tick()
    assert.deepEqual(opened, [{ id: 1, target: 'api.example.test:443' }])
    const hostSide = host.accept(1)
    const guestSide = await opening
    const atHost = collect(hostSide)
    const atGuest = collect(guestSide)

    guestSide.write('request')
    hostSide.write('response')
    await tick()
    assert.equal(atHost.text(), 'request')
    assert.equal(atGuest.text(), 'response')

    guestSide.end()
    await tick()
    assert.equal(atHost.ended(), true, 'the host sees the guest finish')
    assert.equal(atGuest.ended(), false, 'the host side is still open')
    hostSide.write('late')
    hostSide.end()
    await tick()
    assert.equal(atGuest.text(), 'responselate')
    assert.equal(atGuest.ended(), true)
    assert.equal(guestSide.destroyed, true, 'both directions done: the stream is closed')
    assert.equal(hostSide.destroyed, true)
  })

  it('delivers a refusal to the opener as the rejection', async () => {
    const { guest, host } = pair()
    const opening = guest.open('evil.example:443')
    await tick()
    host.refuse(1, 'DENY not in the allowlist')
    await assert.rejects(opening, /DENY not in the allowlist/)
  })

  it('carries a reset, with its reason, to the peer', async () => {
    const { guest, host } = pair()
    const opening = guest.open('api.example.test:443')
    await tick()
    const hostSide = host.accept(1)
    const guestSide = await opening
    const errors: string[] = []
    guestSide.on('error', (error) => {
      errors.push(error.message)
    })
    hostSide.on('error', () => {
      // the destroyer's own error; the peer's copy is what is asserted
    })
    hostSide.destroy(new Error('origin went away'))
    await tick()
    assert.deepEqual(errors, ['origin went away'])
    assert.equal(guestSide.destroyed, true)
  })

  it('answers a ping, and times one out when the peer is silent', async () => {
    const { guest } = pair()
    await guest.ping(500)
    const silentInput = new PassThrough()
    const alone = new EgressLink(silentInput, new PassThrough())
    await assert.rejects(alone.ping(50), /no reply within 50ms/)
    alone.close(undefined)
  })

  it('fails every open stream and pending request when the byte stream ends', async () => {
    const guestToHost = new PassThrough()
    const hostToGuest = new PassThrough()
    const closes: Array<Error | undefined> = []
    const host = new EgressLink(guestToHost, hostToGuest, {
      // Only the first target is answered; the second stays pending.
      onOpen: (id, target): void => {
        if (target.startsWith('api.')) host.accept(id)
      },
    })
    const guest = new EgressLink(hostToGuest, guestToHost, {
      onClose: (error): void => {
        closes.push(error)
      },
    })
    const stream = await guest.open('api.example.test:443')
    const closed = new Promise<void>((resolveClose) => {
      stream.on('close', resolveClose)
    })
    stream.on('error', () => {
      // severed without a reason: no error, just the close
    })
    const pendingOpen = guest.open('later.example.test:443')
    hostToGuest.end()
    await closed
    await assert.rejects(pendingOpen, /egress link closed/)
    assert.equal(guest.isClosed, true)
    assert.equal(closes.length, 1)
    await assert.rejects(guest.open('x.example.test:443'), /egress link is closed/)
    host.close(undefined)
  })

  it('splits a large write into frames the reader reassembles in order', async () => {
    const { guest, host } = pair()
    const opening = guest.open('api.example.test:443')
    await tick()
    const hostSide = host.accept(1)
    const guestSide = await opening
    let received = Buffer.alloc(0)
    let ended = false
    hostSide.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk])
    })
    hostSide.on('end', () => {
      ended = true
    })
    const big = Buffer.alloc(300 * 1024)
    for (let i = 0; i < big.length; i += 1) big[i] = i % 251
    guestSide.end(big)
    await tick(100)
    assert.equal(ended, true)
    assert.equal(received.length, big.length)
    assert.equal(received.equals(big), true)
  })
})
