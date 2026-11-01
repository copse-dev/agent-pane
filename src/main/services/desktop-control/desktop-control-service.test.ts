import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { afterEach, describe, it } from 'node:test'
import {
  DesktopControlService,
  helperSourceWithCallerRequirement,
  openFuses,
  parseDesignatedRequirement,
  readFuseWires,
} from './desktop-control-service.ts'
import { setElectronAppRuntime } from '../electron-app-runtime.ts'

// A stand-in for the Swift helper that speaks the same line protocol, so the
// service's process handling is exercised across a real pipe.
const FAKE_HELPER = String.raw`
const rl = require('node:readline').createInterface({ input: process.stdin })
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n')
out({ ready: true, permissions: { accessibility: true, screenRecording: false } })
const childSessions = new Set()
const childApp = { pid: 84, name: 'Child Copse', bundleId: 'dev.copse.app', active: false, hidden: false }
rl.on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (method === 'startChild') { childSessions.add(params.session); return out({ id, ok: true, result: childApp }) }
  if (method === 'stopChild') { childSessions.delete(params.session); return out({ id, ok: true, result: {} }) }
  if (method === 'validateChild') return out(childSessions.has(params.session) ? { id, ok: true, result: childApp } : { id, ok: false, error: 'Child session ended' })
  if (params.pid === 84) {
    if (!childSessions.has(params.childSession)) return out({ id, ok: false, error: 'Child session ended' })
    if (params.windowId !== undefined && params.windowId !== 99) return out({ id, ok: false, error: 'Window does not belong to this child' })
    if (method === 'snapshot') return out({ id, ok: true, result: { tree: 'child window', nodes: 1, truncated: false, elapsedMs: 1, windowId: 99 } })
  }
  if (method === 'permissions') return out({ id, ok: true, result: { accessibility: true, screenRecording: false } })
  if (method === 'apps') return out({ id, ok: true, result: [{ pid: 42, name: 'Notes', bundleId: 'com.apple.Notes', active: false, hidden: false }] })
  if (method === 'screenshot') return out({ id, ok: true, result: { path: params.path, width: 200, height: 100, frame: { x: 1000, y: 500, width: 400, height: 200 } } })
  if (method === 'click') { process.stderr.write('click ' + JSON.stringify(params) + '\n'); return out({ id, ok: true, result: {} }) }
  if (method === 'press') return out({ id, ok: false, error: 'Unknown or stale ref ' + params.ref })
  if (method === 'snapshot') { process.stderr.write('gone'); process.exit(3) }
  out({ id, ok: true, result: 'not a snapshot' })
})
`

let services: DesktopControlService[] = []

function fakeService(): { service: DesktopControlService; launches: () => number } {
  let count = 0
  const service = new DesktopControlService(() => {
    count++
    return Promise.resolve(
      spawn(process.execPath, ['-e', FAKE_HELPER], { stdio: ['pipe', 'pipe', 'pipe'] }),
    )
  })
  services.push(service)
  return { service, launches: () => count }
}

afterEach(() => {
  for (const service of services) service.dispose()
  services = []
})

describe('DesktopControlService', () => {
  it('matches responses to requests and validates their shape', async () => {
    const { service, launches } = fakeService()
    assert.deepEqual(await service.permissions(), { accessibility: true, screenRecording: false })
    const app = await service.resolveApp('com.apple.Notes')
    assert.equal(app.pid, 42)
    await assert.rejects(service.resolveApp('com.apple.Mail'), /not running/)
    assert.equal(launches(), 1)
  })

  it('surfaces helper errors as tool errors', async () => {
    const { service } = fakeService()
    await assert.rejects(service.press(42, 'e9', undefined), /stale ref e9/)
  })

  it('rejects a result that does not match the schema', async () => {
    const { service } = fakeService()
    await assert.rejects(service.windows(undefined), /unexpected windows result/)
  })

  it('maps screenshot pixels to screen points and refuses clicks without a capture', async () => {
    const { service } = fakeService()
    await assert.rejects(service.clickInCapture(42, 7, 10, 10), /desktop_screenshot/)
    await service.screenshot(7, '/tmp/unused.png')
    // 200×100 image of a 400×200-point window at (1000, 500): pixels are 2× points.
    assert.deepEqual(await service.clickInCapture(42, 7, 50, 25), { x: 1100, y: 550 })
    await assert.rejects(service.clickInCapture(42, 7, 201, 10), /outside/)
  })

  it('fails pending requests when the helper dies and restarts on the next call', async () => {
    const { service, launches } = fakeService()
    await assert.rejects(service.snapshot(42, {}), /exited \(3\): gone/)
    assert.deepEqual(await service.permissions(), { accessibility: true, screenRecording: false })
    assert.equal(launches(), 2)
  })

  it('tags child requests through stop and rejects foreign windows', async () => {
    const { service } = fakeService()
    await service.startChild('session-a', '/Copse.app', '/index.js', '/profile')
    assert.equal((await service.snapshot(84, {})).tree, 'child window')
    await assert.rejects(service.snapshot(84, { windowId: 7 }), /does not belong/)
    await assert.rejects(service.screenshot(7, '/unused.png', undefined, 84), /does not belong/)
    await service.stopChild('session-a')
    await assert.rejects(service.snapshot(84, {}), /Child session ended/)
  })

  it('keeps an in-flight target bound to its original session when a PID is reused', async () => {
    const { service } = fakeService()
    const original = await service.startChild('session-a', '/Copse.app', '/index.js', '/profile-a')
    await service.stopChild('session-a')
    const replacement = await service.startChild(
      'session-b',
      '/Copse.app',
      '/index.js',
      '/profile-b',
    )
    assert.equal(original.pid, replacement.pid)
    await assert.rejects(service.snapshot(original, {}), /Child session ended/)
    assert.equal((await service.snapshot(replacement, {})).tree, 'child window')
  })

  it('never turns stale child PID requests into unrestricted calls after helper restart', async () => {
    const { service } = fakeService()
    await service.startChild('session-a', '/Copse.app', '/index.js', '/profile')
    service.dispose()
    await assert.rejects(service.validateChild('session-a'), /Child session ended/)
    await assert.rejects(service.snapshot(84, {}), /Child session ended/)
  })

  it('honours abort before the helper answers', async () => {
    const { service } = fakeService()
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    await assert.rejects(service.apps(controller.signal), /stop/)
  })
})

describe('helper caller requirement', () => {
  it('reads Developer ID and ad-hoc designated requirements from codesign output', () => {
    assert.equal(
      parseDesignatedRequirement(
        'designated => identifier "dev.copse.app" and anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"\n',
      ),
      'identifier "dev.copse.app" and anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"',
    )
    assert.equal(
      parseDesignatedRequirement(
        '# designated => cdhash H"4746041b12c97641943a947516009f07ff580a1e"\n',
      ),
      'cdhash H"4746041b12c97641943a947516009f07ff580a1e"',
    )
  })

  it('rejects output without a requirement or with characters it cannot embed', () => {
    assert.equal(parseDesignatedRequirement('code object is not signed at all\n'), null)
    assert.equal(parseDesignatedRequirement('designated => identifier "x\u0007"'), null)
  })

  it('prepends the requirement as an escaped Swift string constant', () => {
    assert.equal(
      helperSourceWithCallerRequirement('print(1)\n', 'identifier "a\\b"'),
      'let expectedCallerRequirement = "identifier \\"a\\\\b\\""\nprint(1)\n',
    )
  })
})

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'

/** A binary with one fuse wire per slice, cut into chunks of `size` bytes. */
async function* fuseBinary(wires: readonly string[], size: number): AsyncGenerator<Buffer> {
  const bytes = Buffer.from(
    wires
      .map((wire) => `padding${SENTINEL}\x01${String.fromCharCode(wire.length)}${wire}`)
      .join('') + 'tail',
    'latin1',
  )
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size)
  }
}

describe('Electron fuse check', () => {
  const closed = '0r00110100'

  it("reads every slice's wire however the binary is chunked", async () => {
    for (const size of [1, 7, 33, 4096]) {
      const wires = await readFuseWires(fuseBinary([closed, '1r11000100'], size))
      assert.deepEqual(
        wires.map((wire) => wire.toString('latin1')),
        [closed, '1r11000100'],
        `chunk size ${String(size)}`,
      )
    }
  })

  it('accepts only wires that close Node mode and pin the app to its signed asar', async () => {
    assert.deepEqual(openFuses(await readFuseWires(fuseBinary([closed, closed], 64))), [])
    // Electron's defaults leave Node mode open and the asar unchecked.
    assert.deepEqual(openFuses(await readFuseWires(fuseBinary(['1r11001100'], 64))), [
      'RunAsNode',
      'EnableNodeOptionsEnvironmentVariable',
      'EnableNodeCliInspectArguments',
      'EnableEmbeddedAsarIntegrityValidation',
      'OnlyLoadAppFromAsar',
    ])
    // One open slice of a universal binary is enough to refuse.
    assert.deepEqual(openFuses(await readFuseWires(fuseBinary([closed, '1r00110100'], 64))), [
      'RunAsNode',
    ])
  })

  it(
    'refuses to build the helper in a packaged Copse whose fuses it cannot confirm',
    { skip: process.platform !== 'darwin' },
    async () => {
      setElectronAppRuntime({ userDataPath: '/nonexistent', version: '1.0.0', isPackaged: true })
      const service = new DesktopControlService()
      services.push(service)
      try {
        await assert.rejects(service.permissions(), /Electron fuses \(RunAsNode, /)
      } finally {
        setElectronAppRuntime(null)
      }
    },
  )

  it('treats a binary without a fuse wire as open', async () => {
    assert.deepEqual(await readFuseWires(fuseBinary([], 8)), [])
    assert.equal(openFuses([]).length, 5)
  })
})
