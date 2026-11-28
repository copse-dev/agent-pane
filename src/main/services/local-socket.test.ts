import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { z } from 'zod'
import { connectLocalLine, localSocketPath, serveLocalLine } from './local-socket.ts'

const ping = z.object({ t: z.literal('ping') })
type Ping = z.infer<typeof ping>

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 1_000 && !check(); i++)
    await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(check(), 'condition never held')
}

describe('local socket long-profile fallback', { skip: process.platform === 'win32' }, () => {
  let temp = ''
  let savedTmpdir: string | undefined
  let savedUmask = 0

  beforeEach(() => {
    // A shared, world-writable temp directory and a permissive umask: the
    // case where `mkdirSync`'s mode alone would leave the socket reachable.
    temp = mkdtempSync(join(tmpdir(), 'ls-'))
    chmodSync(temp, 0o1777)
    savedTmpdir = process.env['TMPDIR']
    process.env['TMPDIR'] = temp
    savedUmask = process.umask(0)
  })

  afterEach(() => {
    process.umask(savedUmask)
    if (savedTmpdir === undefined) delete process.env['TMPDIR']
    else process.env['TMPDIR'] = savedTmpdir
    rmSync(temp, { recursive: true, force: true })
  })

  const longProfile = (): string => `/${'x'.repeat(120)}`
  const mode = (path: string): number => statSync(path).mode & 0o777

  it('puts the socket in a user-only directory, and starts and reconnects through it', async () => {
    const path = localSocketPath(longProfile(), 'turn', 'thread')
    assert.equal(dirname(dirname(path)), temp)

    const received: string[] = []
    const server = await serveLocalLine<Ping, Ping>(path, ping, (message, client) => {
      received.push(message.t)
      client.send(message)
    })
    try {
      assert.equal(mode(dirname(path)), 0o700)
      assert.equal(mode(path) & 0o077, 0)

      for (let round = 1; round <= 2; round++) {
        const echoes: string[] = []
        let closed = false
        const connection = await connectLocalLine<Ping, Ping>(
          path,
          ping,
          (message) => echoes.push(message.t),
          () => {
            closed = true
          },
        )
        assert.ok(connection, `connection ${String(round)}`)
        connection.send({ t: 'ping' })
        await until(() => echoes.length === 1)
        connection.close()
        await until(() => closed)
      }
      assert.deepEqual(received, ['ping', 'ping'])
    } finally {
      await server.close()
    }
  })

  it('falls back to /tmp when TMPDIR itself is too long for a socket path', () => {
    const long = join(temp, 'y'.repeat(80))
    process.env['TMPDIR'] = long
    const path = localSocketPath(longProfile(), 'container-run', 'host')
    assert.ok(path.startsWith('/tmp/copse-'), path)
    assert.ok(path.length <= 100, path)
  })

  it('tightens an existing directory of ours that others could enter', async () => {
    const path = localSocketPath(longProfile(), 'run', 'host')
    mkdirSync(dirname(path), { mode: 0o777 })
    chmodSync(dirname(path), 0o777)
    const server = await serveLocalLine<Ping, Ping>(path, ping, () => undefined)
    try {
      assert.equal(mode(dirname(path)), 0o700)
    } finally {
      await server.close()
    }
  })

  it('will not connect to a socket in a directory others can enter', async () => {
    const path = localSocketPath(longProfile(), 'turn', 'loosened')
    const server = await serveLocalLine<Ping, Ping>(path, ping, () => undefined)
    try {
      // Someone else could have placed this socket: the client must not trust it.
      chmodSync(dirname(path), 0o777)
      const refused = await connectLocalLine<Ping, Ping>(
        path,
        ping,
        () => undefined,
        () => undefined,
      )
      assert.equal(refused, null)
      chmodSync(dirname(path), 0o700)
      const connection = await connectLocalLine<Ping, Ping>(
        path,
        ping,
        () => undefined,
        () => undefined,
      )
      assert.ok(connection)
      connection.close()
    } finally {
      await server.close()
    }
  })

  it('refuses a symlink in place of the directory', async () => {
    const path = localSocketPath(longProfile(), 'turn', 'linked')
    const elsewhere = join(temp, 'elsewhere')
    mkdirSync(elsewhere, { mode: 0o777 })
    symlinkSync(elsewhere, dirname(path))
    await assert.rejects(
      serveLocalLine<Ping, Ping>(path, ping, () => undefined),
      /not a directory/,
    )
  })
})

describe('local socket lines', { skip: process.platform === 'win32' }, () => {
  it('reads a line sent in many pieces, and lines that share one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-lines-'))
    const note = z.object({ t: z.literal('note'), text: z.string() })
    const received: string[] = []
    // Wait for the third line itself: a 4 MiB line can take more event-loop
    // turns to drain than a turn-counting wait allows on a slow runner.
    let allThree = (): void => {}
    const third = new Promise<void>((resolve) => (allThree = resolve))
    const path = localSocketPath(dir, 'turn', 'lines')
    const server = await serveLocalLine<z.infer<typeof note>, Ping>(path, note, (message) => {
      received.push(message.text)
      if (received.length === 3) allThree()
    })
    try {
      const socket = createConnection(path)
      await new Promise<void>((resolve) => socket.once('connect', resolve))
      const long = 'x'.repeat(4 * 1024 * 1024)
      const line = JSON.stringify({ t: 'note', text: long })
      for (let at = 0; at < line.length; at += 64 * 1024)
        socket.write(line.slice(at, at + 64 * 1024))
      socket.write('\n{"t":"note","text":"a"}\n{"t":"note",')
      socket.write('"text":"b"}\n')
      await third
      assert.deepEqual(
        received.map((text) => text.length),
        [long.length, 1, 1],
      )
      assert.deepEqual(received.slice(1), ['a', 'b'])
      socket.destroy()
    } finally {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
