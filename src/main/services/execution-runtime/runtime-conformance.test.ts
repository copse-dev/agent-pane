/**
 * One conformance suite for every `ExecutionRuntime` adapter
 * (`docs/plans/execution-runtime-security.md`, R1 exit gate). Each case runs
 * against the local adapter (outside and inside a stand-in sandbox wrap) and
 * the SSH adapter (over a stand-in transport that runs the remote command line
 * locally, as `ssh host 'cd root && …'` would).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deriveRuntimeCapabilities,
  runtimeProfileId,
  type RuntimeProfile,
} from '@shared/threads/execution-runtime.ts'
import { createLocalExecutionRuntime } from '../../project-sandbox/local-runtime.ts'
import { createSshExecutionRuntime } from '../ssh-workspace/ssh-runtime.ts'
import {
  threadExecutionContextStorage,
  type ThreadExecutionContext,
} from '../thread-execution-context-store.ts'
import { withExecutionAudit, type ExecutionObservation } from './audit.ts'
import type { ExecutionRuntime, RuntimeExecRequest } from './runtime.ts'

interface AdapterCase {
  name: string
  expectedProfile: RuntimeProfile
  make: () => ExecutionRuntime
}

// Stands in for ASRT: the wrapped command runs under /bin/sh, as the real wrap's
// argv does, without needing a sandbox on the test host.
const fakeSandboxWrap: Parameters<typeof createLocalExecutionRuntime>[0] = {
  spawn: (file, args, options) => spawn(file, [...args], options),
  wrapWithSandboxArgv: (command) => Promise.resolve({ argv: ['/bin/sh', '-c', command], env: {} }),
  isSandboxEnabled: () => true,
  isSpawnableWorkingDirectory: () => Promise.resolve(true),
  releaseSandboxLease: () => {},
}

const adapters: AdapterCase[] = [
  {
    name: 'local outside the sandbox',
    expectedProfile: { kind: 'local', containment: 'host' },
    make: () => createLocalExecutionRuntime({ ...fakeSandboxWrap, isSandboxEnabled: () => false }),
  },
  {
    name: 'local inside the sandbox',
    expectedProfile: { kind: 'local', containment: 'contained' },
    make: () => createLocalExecutionRuntime(fakeSandboxWrap),
  },
  {
    name: 'ssh',
    expectedProfile: { kind: 'ssh', hostId: 'build-box' },
    make: () =>
      createSshExecutionRuntime(
        { kind: 'ssh', hostId: 'build-box', remoteRoot: '/srv/repo' },
        {
          spawnRemote: (commandLine, options) =>
            Promise.resolve(
              spawn('/bin/sh', ['-c', `cd "$1" && ${commandLine}`, 'sh', options.remoteRoot], {
                env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...options.env },
                stdio: options.stdio,
              }),
            ),
        },
      ),
  },
]

function collect(child: ChildProcess): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => {
      resolve({ stdout, code })
    })
  })
}

function request(cwd: string, overrides: Partial<RuntimeExecRequest> = {}): RuntimeExecRequest {
  return {
    command: { kind: 'shell', commandLine: 'printf "%s|%s" "$COPSE_PROBE" "$(pwd)"; exit 3' },
    cwd,
    env: { COPSE_PROBE: 'overlay' },
    stdio: 'pipe',
    local: { sandbox: true, plan: () => ({ config: {} }) },
    ...overrides,
  }
}

const context: ThreadExecutionContext = {
  projectId: 'proj',
  threadId: 'thread',
  projectRoot: '/repo',
  root: '/repo',
  checkoutMode: 'shared',
  branch: null,
}

for (const adapter of adapters) {
  describe(`ExecutionRuntime conformance: ${adapter.name}`, () => {
    it('propagates stdout, exit code, working directory and env overlay', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'copse-runtime-')))
      try {
        const runtime = adapter.make()
        const execution = await runtime.exec(request(dir))
        const { stdout, code } = await collect(execution.child)
        assert.equal(code, 3)
        assert.equal(stdout, `overlay|${dir}`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('runs argv commands with their arguments intact', async () => {
      const runtime = adapter.make()
      const execution = await runtime.exec(
        request(tmpdir(), {
          command: { kind: 'argv', executable: 'printf', args: ['%s', 'two words'] },
        }),
      )
      assert.equal((await collect(execution.child)).stdout, 'two words')
    })

    it('reports the capabilities of the profile it actually ran under', async () => {
      const runtime = adapter.make()
      const expected = deriveRuntimeCapabilities(adapter.expectedProfile)
      assert.deepEqual(runtime.capabilities(request(tmpdir())), expected)
      const execution = await runtime.exec(request(tmpdir()))
      await collect(execution.child)
      assert.deepEqual(execution.profile, adapter.expectedProfile)
      assert.deepEqual(execution.capabilities, expected)
    })

    it('stops idempotently', async () => {
      const runtime = adapter.make()
      await runtime.stop()
      await runtime.stop()
      const execution = await runtime.exec(request(tmpdir()))
      assert.equal((await collect(execution.child)).code, 3)
    })

    it('emits one start and one exit observation per in-turn execution', async () => {
      const observations: ExecutionObservation[] = []
      const runtime = withExecutionAudit(adapter.make(), () => (o): void => {
        observations.push(o)
      })
      const execution = await threadExecutionContextStorage.run(context, () =>
        runtime.exec(request(tmpdir())),
      )
      await collect(execution.child)
      assert.deepEqual(
        observations.map((o) => o.type),
        ['start', 'exit'],
      )
      const [start, exit] = observations
      assert.ok(start && exit)
      assert.equal(start.processRunId, exit.processRunId)
      assert.equal(runtimeProfileId(start.profile), runtimeProfileId(adapter.expectedProfile))
      assert.equal(start.principal.kind, 'human')
      assert.deepEqual(start.owner, { projectId: 'proj', threadId: 'thread' })
      assert.equal(exit.type === 'exit' ? exit.exitCode : null, 3)
    })

    it('records nothing outside an agent turn', async () => {
      const observations: ExecutionObservation[] = []
      const runtime = withExecutionAudit(adapter.make(), () => (o): void => {
        observations.push(o)
      })
      await collect((await runtime.exec(request(tmpdir()))).child)
      assert.equal(observations.length, 0)
    })
  })
}

describe('local runtime child subscriptions', () => {
  for (const mode of ['host', 'contained', 'hosted'] as const) {
    it(`subscribes before queued spawn events for a ${mode} launch`, async () => {
      const events: string[] = []
      let released = 0
      const launch = (): ChildProcess => {
        const child = new ChildProcess()
        events.push('created')
        queueMicrotask(() => {
          events.push('emitted')
          child.emit('spawn')
        })
        return child
      }
      const runtime = createLocalExecutionRuntime({
        ...fakeSandboxWrap,
        spawn: launch,
        isSandboxEnabled: () => mode !== 'host',
        releaseSandboxLease: () => {
          released += 1
        },
      })
      let observed: ChildProcess | undefined
      const execution = await runtime.exec(
        request(tmpdir(), {
          local: {
            sandbox: true,
            onChildCreated: (child) => {
              observed = child
              events.push('subscribed')
              child.once('spawn', () => events.push('observed'))
            },
            plan: () => ({
              config: {},
              ownsSandboxLease: true,
              ...(mode === 'hosted' ? { hostedLaunch: launch } : {}),
            }),
          },
        }),
      )
      events.push('returned')
      assert.deepEqual(events, ['created', 'subscribed', 'emitted', 'observed', 'returned'])
      assert.equal(observed, execution.child)
      assert.equal(released, 0)
      execution.child.emit('close', 0, null)
      execution.child.emit('close', 0, null)
      assert.equal(released, mode === 'contained' ? 1 : 0)
    })
  }

  it('keeps an owned lease until close if a child observer throws', async () => {
    const child = new ChildProcess()
    const failure = new Error('controlled observer failure')
    let released = 0
    const runtime = createLocalExecutionRuntime({
      ...fakeSandboxWrap,
      spawn: () => child,
      releaseSandboxLease: () => {
        released += 1
      },
    })
    await assert.rejects(
      runtime.exec(
        request(tmpdir(), {
          local: {
            sandbox: true,
            onChildCreated: () => {
              throw failure
            },
            plan: () => ({ config: {}, ownsSandboxLease: true }),
          },
        }),
      ),
      (error: unknown) => error === failure,
    )
    assert.equal(released, 0)
    child.emit('close', 0, null)
    assert.equal(released, 1)
  })
})

describe('local runtime containment decisions', () => {
  it('refuses rather than falling back outside when the sandbox is required', async () => {
    const runtime = createLocalExecutionRuntime({
      ...fakeSandboxWrap,
      isSandboxEnabled: () => false,
    })
    await assert.rejects(
      runtime.exec(
        request(tmpdir(), {
          local: { sandbox: true, requireSandbox: 'needs sandbox', plan: () => ({ config: {} }) },
        }),
      ),
      /needs sandbox/,
    )
  })

  it('runs an approved escape outside the sandbox even when it is active', async () => {
    let wrapped = false
    const runtime = createLocalExecutionRuntime({
      ...fakeSandboxWrap,
      wrapWithSandboxArgv: (command) => {
        wrapped = true
        return Promise.resolve({ argv: ['/bin/sh', '-c', command], env: {} })
      },
    })
    const execution = await runtime.exec(
      request(tmpdir(), { local: { sandbox: false, plan: () => ({ config: {} }) } }),
    )
    await collect(execution.child)
    assert.equal(wrapped, false)
    assert.deepEqual(execution.profile, { kind: 'local', containment: 'host' })
  })

  it('releases a background task sandbox lease once, when it closes', async () => {
    let released = 0
    const runtime = createLocalExecutionRuntime({
      ...fakeSandboxWrap,
      releaseSandboxLease: () => {
        released += 1
      },
    })
    const owned = await runtime.exec(
      request(tmpdir(), {
        local: { sandbox: true, plan: () => ({ config: {}, ownsSandboxLease: true }) },
      }),
    )
    await collect(owned.child)
    assert.equal(released, 1)
    // A foreground command releases its own lease after reading violations.
    const foreground = await runtime.exec(request(tmpdir()))
    await collect(foreground.child)
    assert.equal(released, 1)
  })

  it('hands a hosted contained launch to its host without wrapping it here', async () => {
    let wrapped = false
    let released = 0
    const observations: ExecutionObservation[] = []
    const runtime = withExecutionAudit(
      createLocalExecutionRuntime({
        ...fakeSandboxWrap,
        wrapWithSandboxArgv: (command) => {
          wrapped = true
          return Promise.resolve({ argv: ['/bin/sh', '-c', command], env: {} })
        },
        releaseSandboxLease: () => {
          released += 1
        },
      }),
      () =>
        (o): void => {
          observations.push(o)
        },
    )
    const execution = await threadExecutionContextStorage.run(context, () =>
      runtime.exec(
        request(tmpdir(), {
          local: {
            sandbox: true,
            // Lease fields on a hosted plan must be ignored: main never took
            // the lease, so releasing one would unbalance ASRT's count.
            plan: () => ({
              config: {},
              ownsSandboxLease: true,
              hostedLaunch: (): ChildProcess =>
                spawn('/bin/sh', ['-c', 'exit 4'], { stdio: 'pipe' }),
            }),
          },
        }),
      ),
    )
    assert.equal((await collect(execution.child)).code, 4)
    assert.equal(wrapped, false)
    assert.equal(released, 0)
    assert.deepEqual(execution.profile, { kind: 'local', containment: 'contained' })
    assert.deepEqual(
      observations.map((o) => o.type),
      ['start', 'exit'],
    )
  })

  it('does not spawn a cancelled command when asked to check', async () => {
    const controller = new AbortController()
    controller.abort()
    const runtime = createLocalExecutionRuntime(fakeSandboxWrap)
    await assert.rejects(
      runtime.exec(request(tmpdir(), { signal: controller.signal, abortCheckpoints: true })),
      { name: 'AbortError' },
    )
  })

  it('names a missing working directory before spawning', async () => {
    const runtime = createLocalExecutionRuntime({
      ...fakeSandboxWrap,
      isSpawnableWorkingDirectory: () => Promise.resolve(false),
    })
    await assert.rejects(
      runtime.exec(request('/gone')),
      /Working directory no longer exists: \/gone/,
    )
  })
})
