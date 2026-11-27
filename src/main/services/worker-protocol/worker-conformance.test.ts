import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { z } from 'zod'
import type { LLMProvider } from '@copse/llm/types.ts'
import {
  CONTAINER_RUN_HOST_PROTOCOL,
  hostContainerRun,
  runHostSocketPath,
  runHostToAppSchema,
  type ContainerRunHostRequest,
} from '../container-runtime/run-host.ts'
import { fakeRecord } from '../container-runtime/container-run-record.test-support.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { ToolRegistry } from '../tool-registry.ts'
import {
  hostToAppSchema,
  serveTurnHost,
  TURN_HOST_PROTOCOL,
  turnHostSocketPath,
} from '../turn-host/turn-host-protocol.ts'
import { TurnHost } from '../turn-host/turn-host.ts'
import {
  workerCapabilitiesSchema,
  type WorkerCapabilities,
  type WorkerRole,
} from './worker-capabilities.ts'

/**
 * One conformance suite for every harness worker (`harness-worker-roadmap.md`,
 * R2): each worker is started in this process on a real local socket, and a
 * plain client drives it with raw lines, as a client on another machine would.
 * What every worker must do, whatever its role:
 *
 * - answer `hello` with its role's protocol number, its pid and what it can
 *   run, and say it takes its own role;
 * - write only lines the published schema of its role accepts;
 * - drop a line that does not parse, or a message it does not know, and keep
 *   the line open;
 * - answer each client on its own line, and keep serving after one leaves.
 */

const VERSION = '9.8.7'

interface StartedWorker {
  socketPath: string
  stop: () => Promise<void>
}

interface WorkerUnderTest {
  role: WorkerRole
  protocol: number
  workerToClient: z.ZodType
  start: (dir: string) => Promise<StartedWorker>
}

const turnHost: WorkerUnderTest = {
  role: 'turns',
  protocol: TURN_HOST_PROTOCOL,
  workerToClient: hostToAppSchema,
  start: async (dir): Promise<StartedWorker> => {
    const socketPath = turnHostSocketPath(dir)
    const host = new TurnHost({
      registry: new ToolRegistry(),
      log: (): void => undefined,
      version: VERSION,
      onIdle: (): void => undefined,
      idleMs: 60_000,
      capabilities: (): WorkerCapabilities => ({
        roles: ['turns'],
        models: { chatgptPlan: false, externalAgents: false, remoteAgents: false },
        pluginRuntimes: false,
        sandbox: false,
      }),
    })
    const server = await serveTurnHost(
      socketPath,
      (message, client) => {
        host.handle(message, client)
      },
      () => {
        host.left()
      },
    )
    host.bindBroadcast(server.broadcast)
    return {
      socketPath,
      stop: async (): Promise<void> => {
        host.dispose()
        await server.close()
      },
    }
  },
}

const EGRESS = ['inference.copse.internal:443']

const runRequest: ContainerRunHostRequest = {
  runtimeId: 'run-conformance',
  projectId: 'p1',
  display: {
    threadId: 't1',
    startedAt: 1,
    prompt: 'Fix it',
    model: 'claude-sonnet-4-6',
    egressAllowlist: EGRESS,
    credential: 'host',
    checkout: null,
    continuedFrom: null,
  },
  model: 'claude-sonnet-4-6',
  useAgentLogin: false,
  base: {
    workspace: '/work',
    threadId: 't1',
    prompt: 'Fix it',
    budgets: { wallClockMs: 60_000, tokenCeiling: 10_000 },
    egressAllowlist: EGRESS,
    image: 'copse-worker:test',
    engine: 'docker',
  },
}

const containerRunHost: WorkerUnderTest = {
  role: 'container-run',
  protocol: CONTAINER_RUN_HOST_PROTOCOL,
  workerToClient: runHostToAppSchema,
  start: (dir) => {
    const socketPath = runHostSocketPath(dir, runRequest.runtimeId)
    const ended = new AbortController()
    const listening = Promise.withResolvers<undefined>()
    const outcome = hostContainerRun(runRequest, {
      resolve: () =>
        Promise.resolve({
          mode: 'host-inference',
          model: 'claude-sonnet-4-6',
          contextWindow: 1_000,
          apiKey: null,
          egress: EGRESS,
          hostInference: (): Promise<LLMProvider> => Promise.reject(new Error('not called')),
        }),
      // A run that goes on until the host is told to end.
      run: (_request, options) =>
        new Promise((resolve) => {
          options?.onPhase?.('running')
          listening.resolve(undefined)
          options?.signal?.addEventListener('abort', () => {
            resolve(fakeRecord('t1'))
          })
        }),
      socketPath,
      hostFile: join(dir, 'hosts', 'run.json'),
      log: (): void => undefined,
      lingerMs: 0,
      signal: ended.signal,
      version: VERSION,
    })
    return listening.promise.then(() => ({
      socketPath,
      stop: async (): Promise<void> => {
        ended.abort()
        await outcome
      },
    }))
  },
}

/** A client that writes raw lines and reads back every line the worker writes. */
class RawClient {
  readonly lines: unknown[] = []
  private buffer = ''
  private waiters: (() => void)[] = []
  private readonly socket: Socket
  private constructor(socket: Socket) {
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (data: string) => {
      this.buffer += data
      let at = this.buffer.indexOf('\n')
      while (at !== -1) {
        const line = this.buffer.slice(0, at)
        this.buffer = this.buffer.slice(at + 1)
        if (line.trim()) this.lines.push(JSON.parse(line))
        at = this.buffer.indexOf('\n')
      }
      for (const waiter of this.waiters.splice(0)) waiter()
    })
  }

  static open(path: string): Promise<RawClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(path, () => {
        resolve(new RawClient(socket))
      })
      socket.once('error', reject)
    })
  }

  write(line: string): void {
    this.socket.write(`${line}\n`)
  }

  send(message: unknown): void {
    this.write(JSON.stringify(message))
  }

  /** The first line, from the `from`th on, that passes `check`. */
  async next(check: (line: unknown) => boolean, from = 0): Promise<unknown> {
    const deadline = Date.now() + 5_000
    for (;;) {
      const found = this.lines.slice(from).find(check)
      if (found !== undefined) return found
      if (Date.now() > deadline) throw new Error('the worker did not answer in time')
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
        setTimeout(resolve, 100).unref()
      })
    }
  }

  close(): void {
    this.socket.destroy()
  }
}

const isHello = (line: unknown): boolean => isRecord(line) && line['t'] === 'hello'

for (const worker of [turnHost, containerRunHost]) {
  describe(`worker conformance: ${worker.role}`, { timeout: 30_000 }, () => {
    let dir = ''
    let started: StartedWorker | null = null
    const savedDir = process.env['COPSE_DIR']
    before(async () => {
      // Short, so the socket path fits on every platform.
      dir = mkdtempSync(join(tmpdir(), 'wc-'))
      process.env['COPSE_DIR'] = join(dir, 'ws')
      started = await worker.start(dir)
    })
    after(async () => {
      await started?.stop()
      if (savedDir === undefined) delete process.env['COPSE_DIR']
      else process.env['COPSE_DIR'] = savedDir
      rmSync(dir, { recursive: true, force: true })
    })

    const open = (): Promise<RawClient> => {
      assert.ok(started)
      return RawClient.open(started.socketPath)
    }

    it('answers hello with its protocol, its pid and what it can run', async () => {
      const client = await open()
      client.send({ t: 'hello', version: VERSION, protocol: worker.protocol })
      const hello = await client.next(isHello)
      client.close()
      assert.ok(isRecord(hello))
      assert.equal(hello['protocol'], worker.protocol)
      assert.equal(hello['version'], VERSION)
      assert.equal(hello['pid'], process.pid)
      const capabilities = workerCapabilitiesSchema.parse(hello['capabilities'])
      assert.ok(capabilities.roles.includes(worker.role))
    })

    it('writes only lines its published schema accepts', async () => {
      const client = await open()
      client.send({ t: 'hello', version: VERSION, protocol: worker.protocol })
      client.send({ t: 'attach' })
      await client.next(isHello)
      // Whatever attaching brings, give it a moment to arrive.
      await new Promise((resolve) => setTimeout(resolve, 200))
      client.close()
      assert.ok(client.lines.length > 0)
      for (const line of client.lines) {
        const parsed = worker.workerToClient.safeParse(line)
        assert.ok(parsed.success, `${JSON.stringify(line)}: ${String(parsed.error)}`)
      }
    })

    it('drops a line it cannot read and keeps the line open', async () => {
      const client = await open()
      client.write('this is not JSON')
      client.send({ t: 'no-such-message' })
      client.send({ t: 'hello', version: 42 })
      client.send({ t: 'hello', version: VERSION, protocol: worker.protocol })
      const hello = await client.next(isHello)
      client.close()
      assert.equal(client.lines.filter(isHello).length, 1)
      assert.ok(isRecord(hello))
      assert.equal(hello['version'], VERSION)
    })

    it('answers each client on its own line, and serves on after one leaves', async () => {
      const first = await open()
      const second = await open()
      first.send({ t: 'hello', version: VERSION, protocol: worker.protocol })
      await first.next(isHello)
      first.close()
      second.send({ t: 'hello', version: VERSION, protocol: worker.protocol })
      await second.next(isHello)
      const third = await open()
      third.send({ t: 'hello', version: VERSION, protocol: worker.protocol })
      await third.next(isHello)
      second.close()
      third.close()
      assert.equal(second.lines.filter(isHello).length, 1)
    })
  })
}
