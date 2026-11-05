import { describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import childProcess, { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import {
  profileInspector,
  profileProcess,
  summarizeProfile,
  targetListenerOrigins,
  type CpuProfile,
} from './profile-main-process.mts'

// An ES module main process: there is no `require` in any scope, and the first
// uncaught exception ends the process, as Copse's fault policy quits the app.
// Written to a file because `node -e` exposes a global `require` and would
// hide the failure.
const TARGET = `
process.on('uncaughtException', (error) => {
  console.error('[process] uncaughtException — ' + error.stack)
  process.exit(3)
})
console.error('[target] ready')
setInterval(() => {}, 1000)
`

interface Target {
  child: ChildProcess
  url: string
  stderr: () => string
  dispose: () => Promise<void>
}

async function startTarget(observeSignal = true): Promise<Target> {
  const dir = await mkdtemp(join(tmpdir(), 'profile-main-process-'))
  const file = join(dir, 'target.mjs')
  await writeFile(
    file,
    (observeSignal
      ? "if (process.platform !== 'win32') process.on('SIGUSR1', () => console.error('[signal] SIGUSR1'));\n"
      : '') + TARGET,
  )
  const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', file], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  let url: string
  try {
    url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Target inspector did not open: ${stderr}`))
      }, 5000)
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
        const match = /ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/.exec(stderr)
        if (match && stderr.includes('[target] ready')) {
          clearTimeout(timeout)
          resolve(match[0])
        } else if (/Starting inspector .* failed:/.test(stderr)) {
          clearTimeout(timeout)
          reject(new Error(`Target inspector failed to open: ${stderr}`))
        }
      })
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once('exit', () => {
        clearTimeout(timeout)
        reject(new Error(`Target exited before its inspector opened: ${stderr}`))
      })
    })
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await once(child, 'exit')
    }
    await rm(dir, { recursive: true, force: true })
    throw error
  }
  return {
    child,
    url,
    stderr: () => stderr,
    dispose: async (): Promise<void> => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await once(child, 'exit')
      }
      await rm(dir, { recursive: true, force: true })
    },
  }
}

async function inspectorIsListening(url: string): Promise<boolean> {
  try {
    await fetch(`http://${new URL(url).host}/json/list`, { signal: AbortSignal.timeout(500) })
    return true
  } catch {
    return false
  }
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

async function runProfiler(args: string[]): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(
    process.execPath,
    [join(process.cwd(), 'scripts/profile-main-process.mts'), ...args],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      signal: AbortSignal.timeout(15_000),
    },
  )
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  await once(child, 'exit')
  return { code: child.exitCode, stderr }
}

describe('profiler CLI validation', () => {
  it('rejects invalid port and duration before signalling the target', async () => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "if (process.platform !== 'win32') process.on('SIGUSR1', () => process.exit(42)); console.log('ready'); setInterval(() => {}, 1000)",
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    try {
      await once(child.stdout, 'data')
      assert.ok(child.pid)
      for (const [option, value, message] of [
        ['--port', '0', /Inspector port must be an integer/],
        ['--seconds', 'NaN', /Profile duration must be a positive number/],
      ] as const) {
        const result = await runProfiler(['--pid', String(child.pid), option, value])
        assert.equal(result.code, 1, result.stderr)
        assert.match(result.stderr, message)
        assert.equal(child.exitCode, null, 'invalid input must not signal the target')
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await once(child, 'exit')
      }
    }
  })
})

describe('profileInspector', { timeout: 30_000 }, () => {
  it('profiles an ES module process and closes its inspector without faulting it', async () => {
    const target = await startTarget()
    try {
      assert.ok(target.child.pid)
      const profile = await profileInspector(target.url, 200, target.child.pid)
      assert.ok(profile.samples.length > 0)
      assert.ok(
        await waitFor(async () => !(await inspectorIsListening(target.url)), 5000),
        'the target inspector should close',
      )
      // Give any stray deferred callback time to run before judging the target.
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(target.child.exitCode, null, target.stderr())
      assert.doesNotMatch(target.stderr(), /uncaughtException/)
    } finally {
      await target.dispose()
    }
  })

  it('disconnects from a different process without profiling or closing its inspector', async () => {
    const target = await startTarget()
    try {
      await assert.rejects(profileInspector(target.url, 10, process.pid), /not requested process/)
      assert.equal(await inspectorIsListening(target.url), true)
      assert.equal(target.child.exitCode, null, target.stderr())
      assert.ok(target.child.pid)
      const profile = await profileInspector(target.url, 10, target.child.pid)
      assert.ok(profile.samples.length > 0)
      assert.ok(await waitFor(async () => !(await inspectorIsListening(target.url)), 5000))
    } finally {
      await target.dispose()
    }
  })

  it(
    'binds the CLI inspector port to its requested PID',
    { skip: process.platform === 'win32' },
    async () => {
      const requested = await startTarget()
      const unrelated = await startTarget()
      const dir = await mkdtemp(join(tmpdir(), 'profile-main-cli-'))
      const output = join(dir, 'unexpected.cpuprofile')
      try {
        assert.ok(requested.child.pid)
        const result = await runProfiler([
          '--pid',
          String(requested.child.pid),
          '--port',
          new URL(unrelated.url).port,
          '--seconds',
          '0.01',
          '--out',
          output,
        ])
        assert.equal(result.code, 1, result.stderr)
        assert.match(result.stderr, /not requested process/)
        assert.equal(await inspectorIsListening(unrelated.url), true)
        assert.equal(await inspectorIsListening(requested.url), true)
        assert.equal(unrelated.child.exitCode, null, unrelated.stderr())
        assert.equal(requested.child.exitCode, null, requested.stderr())
        assert.doesNotMatch(requested.stderr(), /\[signal\] SIGUSR1/)
        await assert.rejects(access(output), { code: 'ENOENT' })
      } finally {
        await Promise.all([
          requested.dispose(),
          unrelated.dispose(),
          rm(dir, { recursive: true, force: true }),
        ])
      }
    },
  )

  it(
    'writes a CLI profile and closes only the verified target',
    { skip: process.platform === 'win32' },
    async () => {
      const target = await startTarget()
      const dir = await mkdtemp(join(tmpdir(), 'profile-main-cli-'))
      const output = join(dir, 'main.cpuprofile')
      try {
        assert.ok(target.child.pid)
        const result = await runProfiler([
          '--pid',
          String(target.child.pid),
          '--port',
          new URL(target.url).port,
          '--seconds',
          '0.05',
          '--out',
          output,
        ])
        assert.equal(result.code, 0, result.stderr)
        assert.match(await readFile(output, 'utf8'), /"samples":\[/)
        assert.ok(await waitFor(async () => !(await inspectorIsListening(target.url)), 5000))
        assert.equal(target.child.exitCode, null, target.stderr())
      } finally {
        await Promise.all([target.dispose(), rm(dir, { recursive: true, force: true })])
      }
    },
  )

  it(
    'closes a reactivated non-default inspector when the requested port never opens',
    { skip: process.platform === 'win32' },
    async () => {
      // A JavaScript SIGUSR1 handler replaces Node's inspector activation.
      const target = await startTarget(false)
      const dir = await mkdtemp(join(tmpdir(), 'profile-main-cli-mismatch-'))
      const output = join(dir, 'unexpected.cpuprofile')
      try {
        const reservation = await startTarget()
        const requestedPort = new URL(reservation.url).port
        await reservation.dispose()
        assert.ok(target.child.pid)
        assert.notEqual(new URL(target.url).port, requestedPort)
        // --inspect=...:0 assigned a non-default debugPort. Closing it leaves
        // that configured port in place for the following SIGUSR1 to reopen.
        await profileInspector(target.url, 10, target.child.pid)
        assert.ok(await waitFor(async () => !(await inspectorIsListening(target.url)), 5000))
        const result = await runProfiler([
          '--pid',
          String(target.child.pid),
          '--port',
          requestedPort,
          '--seconds',
          '0.01',
          '--out',
          output,
        ])
        assert.equal(result.code, 1, result.stderr)
        assert.match(result.stderr, /did not become available/)
        assert.equal(
          target.stderr().match(/Debugger listening on /g)?.length,
          2,
          'SIGUSR1 must actually reopen the inspector before cleanup is accepted',
        )
        assert.ok(await waitFor(async () => !(await inspectorIsListening(target.url)), 5000))
        assert.equal(target.child.exitCode, null, target.stderr())
        assert.doesNotMatch(target.stderr(), /uncaughtException/)
        await assert.rejects(access(output), { code: 'ENOENT' })
      } finally {
        await Promise.all([target.dispose(), rm(dir, { recursive: true, force: true })])
      }
    },
  )

  it('reproduces the require-based close that faulted Copse', async () => {
    const target = await startTarget()
    try {
      const socket = new WebSocket(target.url)
      await once(socket, 'open')
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression: "setImmediate(() => require('node:inspector').close())" },
        }),
      )
      await once(socket, 'message')
      socket.close()
      await once(target.child, 'exit')
      assert.equal(target.child.exitCode, 3)
      assert.match(
        target.stderr(),
        /ReferenceError: require is not defined\n\s+at Immediate\.<anonymous> \(<anonymous>:1:46\)/,
      )
    } finally {
      await target.dispose()
    }
  })
})

describe('summarizeProfile', () => {
  it('orders frames by self time', () => {
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: { functionName: '', url: 'main.js', lineNumber: 0 } },
        { id: 2, callFrame: { functionName: 'hot', url: 'main.js', lineNumber: 9 } },
      ],
      samples: [1, 2, 2],
      timeDeltas: [1000, 2000, 3000],
    }
    assert.deepEqual(summarizeProfile(profile, 2), [
      '5.0ms hot main.js:10',
      '1.0ms (anonymous) main.js:1',
    ])
  })
})

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
