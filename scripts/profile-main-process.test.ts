import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  describeError,
  profileInspector,
  summarizeProfile,
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

function assertTargetAlive(target: Target): void {
  assert.equal(target.child.exitCode, null, target.stderr())
  assert.equal(target.child.signalCode, null, target.stderr())
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
      assertTargetAlive(target)
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
      assertTargetAlive(target)
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
        assertTargetAlive(unrelated)
        assertTargetAlive(requested)
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
        assertTargetAlive(target)
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
        const evidence = (): string =>
          [
            `Profiler exit code: ${String(result.code)}`,
            `Profiler stderr:\n${result.stderr}`,
            `Target PID: ${String(target.child.pid)}; exit code: ${String(target.child.exitCode)}; signal: ${String(target.child.signalCode)}`,
            `Target stderr:\n${target.stderr()}`,
          ].join('\n')
        assert.equal(result.code, 1, evidence())
        assert.match(result.stderr, /did not become available/, evidence())
        assert.equal(target.child.exitCode, null, evidence())
        assert.equal(target.child.signalCode, null, evidence())
        assert.doesNotMatch(
          result.stderr,
          /cleanup could not be confirmed|may still be open/,
          evidence(),
        )
        assert.equal(
          target.stderr().match(/Debugger listening on /g)?.length,
          2,
          `SIGUSR1 must actually reopen the inspector before cleanup is accepted\n${evidence()}`,
        )
        assert.ok(
          await waitFor(async () => !(await inspectorIsListening(target.url)), 5000),
          evidence(),
        )
        assert.equal(target.child.exitCode, null, evidence())
        assert.equal(target.child.signalCode, null, evidence())
        assert.doesNotMatch(target.stderr(), /uncaughtException/, evidence())
        await assert.rejects(access(output), { code: 'ENOENT' }, evidence())
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

describe('describeError', () => {
  it('prints every nested cause and aggregated failure with process details', () => {
    const lsof = Object.assign(new Error('Command failed: lsof -nP -p 7 -F0pfPnT\nlsof: denied'), {
      status: 1,
      signal: null,
    })
    const reset = new TypeError('fetch failed', {
      cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    })
    const cleanup = new AggregateError(
      [new Error('Inspector did not close: http://127.0.0.1:9', { cause: reset })],
      'Could not verify cleanup of every new target listener',
    )
    const discovery = new Error('Cannot discover listeners for process 7', { cause: lsof })
    const error = new AggregateError(
      [new Error('Inspector on port 9 did not become available'), cleanup, discovery],
      'Inspector activation failed; its inspector may still be open',
      { cause: discovery },
    )
    assert.equal(
      describeError(error),
      [
        'AggregateError: Inspector activation failed; its inspector may still be open',
        '  [1/3] Error: Inspector on port 9 did not become available',
        '  [2/3] AggregateError: Could not verify cleanup of every new target listener',
        '    [1/1] Error: Inspector did not close: http://127.0.0.1:9',
        '      caused by: TypeError: fetch failed',
        '        caused by: Error: socket hang up (code ECONNRESET)',
        '  [3/3] Error: Cannot discover listeners for process 7',
        '    caused by: Error: Command failed: lsof -nP -p 7 -F0pfPnT (exit status 1)',
        '      lsof: denied',
      ].join('\n'),
    )
    assert.equal(describeError('plain'), 'plain')
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
