import { describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { profileProcess, targetListenerOrigins } from './profile-main-process.mts'

const HOST_PID = 4242
const REQUESTED_PORT = 19229
const OPENED_PORT = 19330

function listenerSnapshot(ports: number[] = []): string {
  return [
    `p${String(HOST_PID)}`,
    'f0',
    'tCHR',
    'n/dev/null',
    ...ports.flatMap((port, index) => [
      `f${String(index + 10)}`,
      'tIPv4',
      'PTCP',
      `n127.0.0.1:${String(port)}`,
      'TST=LISTEN',
    ]),
  ].join('\0')
}

/** Fake only OS/CDP boundaries; run the real activation and cleanup control flow. */
function mockProfilerHost(
  context: TestContext,
  snapshots: (string | Error)[],
  inspectors = new Map([[OPENED_PORT, HOST_PID]]),
): {
  closedInspectors: number[]
  methods: string[]
  signals: { pid: number; signal: NodeJS.Signals | number | undefined }[]
} {
  const closedInspectors: number[] = []
  const methods: string[] = []
  const signals: { pid: number; signal: NodeJS.Signals | number | undefined }[] = []
  let clock = 0
  context.mock.method(Date, 'now', () => (clock += 1000))
  context.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    signals.push({ pid, signal })
    return true
  })
  context.mock.method(childProcess, 'execFileSync', (file: string, args: string[]) => {
    assert.equal(file, 'lsof')
    assert.ok(args.includes(String(HOST_PID)))
    const snapshot = snapshots.shift()
    assert.notEqual(snapshot, undefined, 'unexpected listener scan')
    if (snapshot instanceof Error) throw snapshot
    return snapshot
  })
  context.mock.method(globalThis, 'fetch', (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const port = Number(url.port)
    if (!inspectors.has(port)) {
      return Promise.reject(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
        }),
      )
    }
    return Promise.resolve(Response.json([{ webSocketDebuggerUrl: `ws://${url.host}/inspector` }]))
  })
  const requestSchema = z.object({
    id: z.number(),
    method: z.string(),
    params: z.object({ expression: z.string().optional() }).optional(),
  })
  context.mock.method(
    globalThis,
    'WebSocket',
    class extends EventTarget {
      readonly port: number

      constructor(url: string) {
        super()
        this.port = Number(new URL(url).port)
        queueMicrotask(() => this.dispatchEvent(new Event('open')))
      }

      send = (data: string): void => {
        const request = safeJsonParse(data, decodeWithSchema(requestSchema))
        assert.ok(request)
        methods.push(request.method)
        let result: unknown = {}
        if (request.params?.expression === 'process.pid') {
          result = { result: { type: 'number', value: inspectors.get(this.port) } }
        } else if (request.params?.expression?.includes('inspector')) {
          closedInspectors.push(this.port)
          inspectors.delete(this.port)
        } else if (request.method === 'Profiler.stop') {
          result = { profile: { nodes: [], samples: [], timeDeltas: [] } }
        }
        this.dispatchEvent(
          new MessageEvent('message', { data: JSON.stringify({ id: request.id, result }) }),
        )
      }

      close = (): void => {
        this.dispatchEvent(new Event('close'))
      }
    },
  )
  return { closedInspectors, methods, signals }
}

describe('profileProcess activation cleanup', { skip: process.platform === 'win32' }, () => {
  it('confirms closure after a transient socket reset instead of reporting the inspector unconfirmed', async (context) => {
    const host = mockProfilerHost(context, [listenerSnapshot(), listenerSnapshot([OPENED_PORT])])
    const fetchBoundary = globalThis.fetch
    let confirmationRequests = 0
    let clock = 0
    context.mock.method(Date, 'now', () => (clock += host.closedInspectors.length > 0 ? 100 : 1000))
    context.mock.method(globalThis, 'fetch', (input: string | URL | Request) => {
      if (host.closedInspectors.length > 0) {
        confirmationRequests += 1
        if (confirmationRequests === 1) {
          return Promise.reject(
            new TypeError('fetch failed', {
              cause: Object.assign(new Error('connection reset while closing'), {
                code: 'ECONNRESET',
              }),
            }),
          )
        }
      }
      return fetchBoundary(input)
    })
    await assert.rejects(profileProcess(HOST_PID, REQUESTED_PORT, 1), /did not become available/)
    assert.equal(
      confirmationRequests,
      2,
      'a reset alone is not confirmation; the next probe must refuse',
    )
    assert.deepEqual(host.closedInspectors, [OPENED_PORT])
    assert.deepEqual(host.methods, ['Runtime.evaluate', 'Runtime.evaluate'])
  })

  it('keeps the explicit unconfirmed-cleanup failure when reset probes never confirm closure', async (context) => {
    const host = mockProfilerHost(context, [listenerSnapshot(), listenerSnapshot([OPENED_PORT])])
    const fetchBoundary = globalThis.fetch
    let clock = 0
    context.mock.method(Date, 'now', () => (clock += host.closedInspectors.length > 0 ? 100 : 1000))
    context.mock.method(globalThis, 'fetch', (input: string | URL | Request) => {
      if (host.closedInspectors.length > 0) {
        return Promise.reject(
          new TypeError('fetch failed', {
            cause: Object.assign(new Error('connection reset while closing'), {
              code: 'ECONNRESET',
            }),
          }),
        )
      }
      return fetchBoundary(input)
    })
    await assert.rejects(
      profileProcess(HOST_PID, REQUESTED_PORT, 1),
      /its inspector may still be open/,
    )
    assert.deepEqual(host.closedInspectors, [OPENED_PORT])
  })

  it('closes a newly opened inspector on another configured port after activation fails', async (context) => {
    const host = mockProfilerHost(context, [listenerSnapshot(), listenerSnapshot([OPENED_PORT])])
    await assert.rejects(profileProcess(HOST_PID, REQUESTED_PORT, 1), /did not become available/)
    assert.deepEqual(host.signals, [{ pid: HOST_PID, signal: 'SIGUSR1' }])
    assert.deepEqual(host.closedInspectors, [OPENED_PORT])
    assert.deepEqual(host.methods, ['Runtime.evaluate', 'Runtime.evaluate'])
  })

  it('refuses to signal when listener discovery is missing or denied', async (context) => {
    const host = mockProfilerHost(context, [new Error('spawn lsof ENOENT')])
    await assert.rejects(profileProcess(HOST_PID, REQUESTED_PORT, 1), /requires readable Unix lsof/)
    assert.deepEqual(host.signals, [])
    assert.deepEqual(host.closedInspectors, [])
  })

  it('refuses to signal when the process is absent from the discovery result', async (context) => {
    const host = mockProfilerHost(context, ['p9999\0\nf0\0n/dev/null\0\n'])
    await assert.rejects(profileProcess(HOST_PID, REQUESTED_PORT, 1), /requires readable Unix lsof/)
    assert.deepEqual(host.signals, [])
  })

  it('preserves an inspector that was already open on another port', async (context) => {
    const snapshot = listenerSnapshot([OPENED_PORT])
    const host = mockProfilerHost(context, [snapshot, snapshot])
    await assert.rejects(profileProcess(HOST_PID, REQUESTED_PORT, 1), /did not become available/)
    assert.deepEqual(host.closedInspectors, [])
    assert.deepEqual(host.methods, [])
  })

  it('rechecks PID ownership before closing a discovered inspector', async (context) => {
    const host = mockProfilerHost(
      context,
      [listenerSnapshot(), listenerSnapshot([OPENED_PORT])],
      new Map([[OPENED_PORT, HOST_PID + 1]]),
    )
    await assert.rejects(
      profileProcess(HOST_PID, REQUESTED_PORT, 1),
      /cleanup could not be confirmed/,
    )
    assert.deepEqual(host.closedInspectors, [])
    assert.deepEqual(host.methods, ['Runtime.evaluate'])
  })

  it('reports an inspector may remain open if discovery fails after the signal', async (context) => {
    const host = mockProfilerHost(context, [listenerSnapshot(), new Error('permission denied')])
    await assert.rejects(
      profileProcess(HOST_PID, REQUESTED_PORT, 1),
      /its inspector may still be open/,
    )
    assert.deepEqual(host.signals, [{ pid: HOST_PID, signal: 'SIGUSR1' }])
    assert.deepEqual(host.closedInspectors, [])
  })

  it('continues cleanup after a different new listener cannot be inspected', async (context) => {
    const host = mockProfilerHost(
      context,
      [listenerSnapshot(), listenerSnapshot([OPENED_PORT + 1, OPENED_PORT])],
      new Map([
        [OPENED_PORT + 1, HOST_PID + 1],
        [OPENED_PORT, HOST_PID],
      ]),
    )
    await assert.rejects(
      profileProcess(HOST_PID, REQUESTED_PORT, 1),
      /cleanup could not be confirmed/,
    )
    assert.deepEqual(host.closedInspectors, [OPENED_PORT])
  })

  it('does not signal or close an existing requested endpoint owned by another PID', async (context) => {
    const host = mockProfilerHost(context, [], new Map([[REQUESTED_PORT, HOST_PID + 1]]))
    await assert.rejects(profileProcess(HOST_PID, REQUESTED_PORT, 1), /not requested process/)
    assert.deepEqual(host.signals, [])
    assert.deepEqual(host.closedInspectors, [])
    assert.deepEqual(host.methods, ['Runtime.evaluate'])
  })

  it('bounds cleanup when an endpoint does not answer the PID request', async (context) => {
    mockProfilerHost(context, [listenerSnapshot(), listenerSnapshot([OPENED_PORT])])
    let disconnected = false
    context.mock.method(
      globalThis,
      'WebSocket',
      class extends EventTarget {
        constructor() {
          super()
          queueMicrotask(() => this.dispatchEvent(new Event('open')))
        }

        send = (): void => {
          // An accepting endpoint that never answers CDP must not hang cleanup.
        }

        close = (): void => {
          disconnected = true
          this.dispatchEvent(new Event('close'))
        }
      },
    )
    await assert.rejects(
      profileProcess(HOST_PID, REQUESTED_PORT, 1),
      /cleanup could not be confirmed/,
    )
    assert.equal(disconnected, true)
  })

  it('profiles an existing requested inspector without requiring discovery or a signal', async (context) => {
    const host = mockProfilerHost(context, [], new Map([[REQUESTED_PORT, HOST_PID]]))
    await profileProcess(HOST_PID, REQUESTED_PORT, 1)
    assert.deepEqual(host.signals, [])
    assert.deepEqual(host.closedInspectors, [REQUESTED_PORT])
    assert.deepEqual(host.methods, [
      'Runtime.evaluate',
      'Profiler.enable',
      'Profiler.start',
      'Profiler.stop',
      'Profiler.disable',
      'Runtime.evaluate',
    ])
  })
})

describe('targetListenerOrigins', () => {
  it('selects only listening TCP sockets on the requested PID', () => {
    const output = [
      listenerSnapshot([OPENED_PORT]),
      'f20',
      'PTCP',
      'n127.0.0.1:1234->127.0.0.1:5678',
      'TST=ESTABLISHED',
      'f21',
      'PUDP',
      'n127.0.0.1:4321',
      'p9999',
      'f22',
      'PTCP',
      'n127.0.0.1:8888',
      'TST=LISTEN',
    ].join('\0')
    assert.deepEqual(
      targetListenerOrigins(output, HOST_PID),
      new Set([`http://127.0.0.1:${String(OPENED_PORT)}`]),
    )
  })

  it('recognizes IPv6, bind-all and numeric interface addresses', () => {
    const output = [
      `p${String(HOST_PID)}`,
      ...['*:1234', '[::]:1235', '[::1]:1236', '192.0.2.1:1237'].flatMap((address) => [
        'f10',
        'PTCP',
        `n${address}`,
        'TST=LISTEN',
      ]),
    ].join('\0')
    assert.deepEqual(
      targetListenerOrigins(output, HOST_PID),
      new Set([
        'http://127.0.0.1:1234',
        'http://[::1]:1234',
        'http://[::1]:1235',
        'http://[::1]:1236',
        'http://192.0.2.1:1237',
      ]),
    )
  })

  it('distinguishes an inspectable process with no listeners from missing process data', () => {
    assert.deepEqual(targetListenerOrigins(listenerSnapshot(), HOST_PID), new Set())
    assert.throws(() => targetListenerOrigins('', HOST_PID), /Cannot inspect requested process/)
    assert.throws(
      () => targetListenerOrigins(`p${String(HOST_PID)}\0`, HOST_PID),
      /Cannot inspect requested process/,
    )
    assert.throws(
      () => targetListenerOrigins('p9999\0f0\0n/dev/null\0', HOST_PID),
      /Cannot inspect requested process/,
    )
  })

  it('rejects malformed listening addresses before they can authorize activation', () => {
    for (const address of ['localhost:9229', '127.0.0.1:70000', 'not-an-address']) {
      const output = [`p${String(HOST_PID)}`, 'f10', 'PTCP', `n${address}`, 'TST=LISTEN'].join('\0')
      assert.throws(() => targetListenerOrigins(output, HOST_PID), /Cannot parse|not a numeric/)
    }
  })

  it('handles real lsof record separators without trusting newline-bearing file names', () => {
    const output = [
      `p${String(HOST_PID)}`,
      '\nf0',
      'n/a-file\nf10\nPTCP\nn127.0.0.1:7777\nTST=LISTEN',
      '\nf20',
      'PTCP',
      `n127.0.0.1:${String(OPENED_PORT)}`,
      'TST=LISTEN',
      '\n',
    ].join('\0')
    assert.deepEqual(
      targetListenerOrigins(output, HOST_PID),
      new Set([`http://127.0.0.1:${String(OPENED_PORT)}`]),
    )
  })
})
