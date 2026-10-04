import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  assignDebugPort,
  canListenOnDebugPort,
  DEBUG_PORT_MAX,
  DEBUG_PORT_MAX_PROBES,
  DEBUG_PORT_MIN,
  nextDebugPort,
  resetDebugPortsForTest,
  type ChromeCapabilities,
  type DebugPortProbe,
} from '../tests/e2e/helpers/debug-port.ts'

/** The `--remote-debugging-port=` value in a capabilities object, or null. */
function portArg(capabilities: ChromeCapabilities): number | null {
  const args = capabilities['goog:chromeOptions']?.args ?? []
  const prefix = '--remote-debugging-port='
  const found = args.filter((a) => a.startsWith(prefix))
  assert.ok(found.length <= 1, `expected at most one port arg, got ${String(found.length)}`)
  const only = found[0]
  return only === undefined ? null : Number(only.slice(prefix.length))
}

/** Every port is free: isolates the allocator's rotation from the host's sockets. */
const allFree: DebugPortProbe = () => Promise.resolve(true)

/** Reports the first `count` probed ports as held, recording which they were. */
function firstHeld(count: number): { probe: DebugPortProbe; held: number[] } {
  const held: number[] = []
  const probe: DebugPortProbe = (port) => {
    if (held.length < count) {
      held.push(port)
      return Promise.resolve(false)
    }
    return Promise.resolve(true)
  }
  return { probe, held }
}

beforeEach(() => {
  resetDebugPortsForTest()
})

describe('nextDebugPort', () => {
  it('stays inside the range', async () => {
    for (let i = 0; i < 200; i++) {
      const port = await nextDebugPort(allFree)
      assert.ok(port >= DEBUG_PORT_MIN && port < DEBUG_PORT_MAX, `out of range: ${String(port)}`)
    }
  })

  // reloadSession relaunches Electron from the same worker: a fixed port rebinds
  // onto whatever the just-exited Electron's children still hold (run 31193584160).
  it('never hands out the same port twice', async () => {
    const seen = new Set<number>()
    for (let i = 0; i < 400; i++) {
      const port = await nextDebugPort(allFree)
      assert.equal(seen.has(port), false, `reused port ${String(port)} on call ${String(i)}`)
      seen.add(port)
    }
  })

  it('recycles rather than hanging once the range is exhausted', async () => {
    const total = DEBUG_PORT_MAX - DEBUG_PORT_MIN
    for (let i = 0; i < total; i++) await nextDebugPort(allFree)
    // The next call has nothing unused left; it must still return a valid port.
    const port = await nextDebugPort(allFree)
    assert.ok(port >= DEBUG_PORT_MIN && port < DEBUG_PORT_MAX)
  })

  // The bug: a detached gortex daemon inherited an earlier Electron's devtools
  // socket and kept it listening; a later worker drew that port and its
  // Electron came up undebuggable (run 36765082012, e2e shard 2).
  it('skips ports that already have a listener', async () => {
    const { probe, held } = firstHeld(3)
    const port = await nextDebugPort(probe)
    assert.equal(held.length, 3)
    assert.equal(held.includes(port), false, `handed out held port ${String(port)}`)
  })

  it('does not probe a held port again later in the worker', async () => {
    const { probe, held } = firstHeld(5)
    await nextDebugPort(probe)
    const later = new Set<number>()
    for (let i = 0; i < 200; i++) later.add(await nextDebugPort(allFree))
    for (const port of held) assert.equal(later.has(port), false, `re-drew ${String(port)}`)
  })

  it('fails with a diagnosis when every probe finds a listener', async () => {
    const { probe, held } = firstHeld(Number.POSITIVE_INFINITY)
    await assert.rejects(nextDebugPort(probe), /No free devtools port .* after 50 probes/)
    assert.equal(held.length, DEBUG_PORT_MAX_PROBES)
  })
})

describe('canListenOnDebugPort', () => {
  const servers: Server[] = []

  /** Listen the way Chromium's devtools server does: loopback IPv4. */
  async function listenOnLoopback(): Promise<number> {
    const server = createServer()
    servers.push(server)
    await new Promise<void>((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, resolve))
    const address = server.address()
    assert.ok(address !== null && typeof address === 'object')
    return address.port
  }

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('reports a port with a live listener as unusable', async () => {
    const port = await listenOnLoopback()
    assert.equal(await canListenOnDebugPort(port), false)
  })

  it('reports the port usable once the listener is gone, and releases it', async () => {
    const port = await listenOnLoopback()
    const server = servers.pop()
    assert.ok(server)
    await new Promise((resolve) => server.close(resolve))
    assert.equal(await canListenOnDebugPort(port), true)
    // A second probe would fail if the first had left its own listener behind.
    assert.equal(await canListenOnDebugPort(port), true)
  })
})

describe('assignDebugPort', () => {
  it('adds a port arg when the capabilities carry none', async () => {
    const cap: ChromeCapabilities = {
      'goog:chromeOptions': { args: ['--no-sandbox', '--disable-gpu'] },
    }
    const port = await assignDebugPort(cap, allFree)
    assert.equal(portArg(cap), port)
    // Unrelated args survive.
    assert.deepEqual(cap['goog:chromeOptions']?.args?.slice(0, 2), [
      '--no-sandbox',
      '--disable-gpu',
    ])
  })

  // reloadSession re-sends the capabilities it already holds, so a second
  // assignment must replace the stale port rather than append beside it —
  // Chromium takes the first --remote-debugging-port and would keep rebinding it.
  it('replaces an existing port arg instead of appending', async () => {
    const cap: ChromeCapabilities = {
      'goog:chromeOptions': { args: ['--no-sandbox', '--remote-debugging-port=9395'] },
    }
    const first = await assignDebugPort(cap, allFree)
    const second = await assignDebugPort(cap, allFree)
    assert.notEqual(first, second)
    assert.equal(portArg(cap), second)
    assert.equal(cap['goog:chromeOptions']?.args?.length, 2)
  })

  it('rotates the port across repeated assignments to one capabilities object', async () => {
    const cap: ChromeCapabilities = { 'goog:chromeOptions': { args: [] } }
    const seen = new Set<number>()
    for (let i = 0; i < 50; i++) {
      const port = await assignDebugPort(cap, allFree)
      assert.equal(seen.has(port), false, `reload ${String(i)} reused port ${String(port)}`)
      seen.add(port)
      assert.equal(portArg(cap), port)
    }
  })

  it('never assigns a port that has a listener', async () => {
    const { probe, held } = firstHeld(2)
    const cap: ChromeCapabilities = { 'goog:chromeOptions': { args: [] } }
    const port = await assignDebugPort(cap, probe)
    assert.equal(portArg(cap), port)
    assert.equal(held.includes(port), false)
  })

  it('tolerates capabilities with no chromeOptions at all', async () => {
    const cap: ChromeCapabilities = {}
    const port = await assignDebugPort(cap, allFree)
    assert.equal(portArg(cap), port)
  })

  it('does not mutate the previous chromeOptions object', async () => {
    // reloadSession shallow-copies requestedCapabilities, so the copy shares the
    // chromeOptions reference. Replacing the object (not editing its args in
    // place) is what makes the fresh port visible to the in-flight copy.
    const original = { args: ['--no-sandbox'] }
    const cap: ChromeCapabilities = { 'goog:chromeOptions': original }
    await assignDebugPort(cap, allFree)
    assert.deepEqual(original.args, ['--no-sandbox'])
    assert.notEqual(cap['goog:chromeOptions'], original)
  })
})
