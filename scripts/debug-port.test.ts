import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
  assignDebugPort,
  DEBUG_PORT_MAX,
  DEBUG_PORT_MIN,
  nextDebugPort,
  resetDebugPortsForTest,
  type ChromeCapabilities,
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

beforeEach(() => {
  resetDebugPortsForTest()
})

describe('nextDebugPort', () => {
  it('stays inside the range', () => {
    for (let i = 0; i < 200; i++) {
      const port = nextDebugPort()
      assert.ok(port >= DEBUG_PORT_MIN && port < DEBUG_PORT_MAX, `out of range: ${String(port)}`)
    }
  })

  // The bug: a shard rebinds one port ~25 times, each onto the port the process
  // it replaces has only just released (run 31193584160, all 8 e2e shards).
  it('never hands out the same port twice', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 400; i++) {
      const port = nextDebugPort()
      assert.equal(seen.has(port), false, `reused port ${String(port)} on call ${String(i)}`)
      seen.add(port)
    }
  })

  it('recycles rather than hanging once the range is exhausted', () => {
    const total = DEBUG_PORT_MAX - DEBUG_PORT_MIN
    for (let i = 0; i < total; i++) nextDebugPort()
    // The next call has nothing unused left; it must still return a valid port.
    const port = nextDebugPort()
    assert.ok(port >= DEBUG_PORT_MIN && port < DEBUG_PORT_MAX)
  })
})

describe('assignDebugPort', () => {
  it('adds a port arg when the capabilities carry none', () => {
    const cap: ChromeCapabilities = {
      'goog:chromeOptions': { args: ['--no-sandbox', '--disable-gpu'] },
    }
    const port = assignDebugPort(cap)
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
  it('replaces an existing port arg instead of appending', () => {
    const cap: ChromeCapabilities = {
      'goog:chromeOptions': { args: ['--no-sandbox', '--remote-debugging-port=9395'] },
    }
    const first = assignDebugPort(cap)
    const second = assignDebugPort(cap)
    assert.notEqual(first, second)
    assert.equal(portArg(cap), second)
    assert.equal(cap['goog:chromeOptions']?.args?.length, 2)
  })

  it('rotates the port across repeated assignments to one capabilities object', () => {
    const cap: ChromeCapabilities = { 'goog:chromeOptions': { args: [] } }
    const seen = new Set<number>()
    for (let i = 0; i < 50; i++) {
      const port = assignDebugPort(cap)
      assert.equal(seen.has(port), false, `reload ${String(i)} reused port ${String(port)}`)
      seen.add(port)
      assert.equal(portArg(cap), port)
    }
  })

  it('tolerates capabilities with no chromeOptions at all', () => {
    const cap: ChromeCapabilities = {}
    const port = assignDebugPort(cap)
    assert.equal(portArg(cap), port)
  })

  it('does not mutate the previous chromeOptions object', () => {
    // reloadSession shallow-copies requestedCapabilities, so the copy shares the
    // chromeOptions reference. Replacing the object (not editing its args in
    // place) is what makes the fresh port visible to the in-flight copy.
    const original = { args: ['--no-sandbox'] }
    const cap: ChromeCapabilities = { 'goog:chromeOptions': original }
    assignDebugPort(cap)
    assert.deepEqual(original.args, ['--no-sandbox'])
    assert.notEqual(cap['goog:chromeOptions'], original)
  })
})
