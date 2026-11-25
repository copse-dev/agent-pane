import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { LLMProvider } from '@copse/llm/types.ts'
import type { ContainerProviderPlan } from '../providers/container-provider.ts'
import { fakeRecord } from './container-run-record.test-support.ts'
import {
  canHostOutsideApp,
  hostContainerRun,
  listLiveRunHosts,
  type ContainerRunHostRequest,
  type RunHostDependencies,
  type RunHostOutcome,
} from './run-host.ts'
import {
  followHost,
  RunHostDetached,
  runThroughHost,
  type RunHostClientDependencies,
} from './run-host-client.ts'
import type { RunThreadOptions, ThreadContainerRequest } from './thread-container.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'run-host-'))
  dirs.push(dir)
  return dir
}

const EGRESS = ['inference.copse.internal:443']

function plan(egress = EGRESS): ContainerProviderPlan {
  return {
    mode: 'host-inference',
    model: 'claude-sonnet-4-6',
    contextWindow: 1_000,
    apiKey: null,
    egress,
    hostInference: (): Promise<LLMProvider> => Promise.reject(new Error('not called')),
  }
}

function hostRequest(overrides: Partial<ContainerRunHostRequest> = {}): ContainerRunHostRequest {
  return {
    runtimeId: 'run-test-1',
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
    ...overrides,
  }
}

/**
 * The client wired to a host running in this process, so the line between
 * them is the real socket and only the spawn is left out.
 */
function inProcess(
  dir: string,
  host: Omit<RunHostDependencies, 'socketPath' | 'hostFile' | 'log'>,
): { client: RunHostClientDependencies; hostFile: string; outcome: Promise<RunHostOutcome> } {
  const socketPath = join(dir, 'host.sock')
  const hostFile = join(dir, 'hosts', 'run.json')
  let resolveOutcome: (outcome: RunHostOutcome) => void = () => undefined
  const outcome = new Promise<RunHostOutcome>((resolve) => {
    resolveOutcome = resolve
  })
  let pending: ContainerRunHostRequest | null = null
  return {
    hostFile,
    outcome,
    client: {
      writeRequest: (request): Promise<string> => {
        pending = request
        return Promise.resolve('request.json')
      },
      launch: (): Promise<{ exited: Promise<void> }> => {
        const request = pending
        assert.ok(request)
        const run = hostContainerRun(request, {
          ...host,
          socketPath,
          hostFile,
          log: (): void => undefined,
          lingerMs: 1_000,
        })
        void run.then(resolveOutcome)
        return Promise.resolve({ exited: run.then(() => undefined) })
      },
      socketPath: (): string => socketPath,
    },
  }
}

describe('container run host', () => {
  it('runs on the provider it resolves itself, and reports to the app', async () => {
    const dir = scratch()
    const seen: ThreadContainerRequest[] = []
    const wired = inProcess(dir, {
      resolve: (model, options) => {
        assert.equal(model, 'claude-sonnet-4-6')
        assert.deepEqual(options, { useAgentLogin: false, threadId: 't1' })
        return Promise.resolve(plan())
      },
      run: (request, options): Promise<ReturnType<typeof fakeRecord>> => {
        seen.push(request)
        assert.ok(existsSync(wired.hostFile), 'a live host says where it is')
        options?.onLog?.('booting')
        options?.onPhase?.('running')
        return Promise.resolve(fakeRecord('t1'))
      },
    })
    const lines: string[] = []
    const phases: string[] = []
    const record = await runThroughHost(
      hostRequest(),
      { onLog: (line) => lines.push(line), onPhase: (phase) => phases.push(phase) },
      wired.client,
    )
    assert.equal(record.result?.finalText, 'Done.')
    assert.deepEqual(lines, ['booting'])
    assert.deepEqual(phases, ['running'])
    const request = seen.at(0)
    assert.ok(request)
    assert.ok(request.hostInference, 'the host built the provider')
    assert.equal(request.workspace, '/work')
    assert.deepEqual((await wired.outcome).status, 'done')
    assert.equal(existsSync(wired.hostFile), false, 'an ended host removes its file')
  })

  it("stops the run when the app's signal fires", async () => {
    const dir = scratch()
    const wired = inProcess(dir, {
      resolve: () => Promise.resolve(plan()),
      run: (_request, options?: RunThreadOptions) =>
        new Promise((_resolve, reject) => {
          options?.onPhase?.('running')
          options?.signal?.addEventListener('abort', () => {
            reject(new Error('Stopped by you before the guest finished'))
          })
        }),
    })
    const stop = new AbortController()
    const run = runThroughHost(
      hostRequest(),
      {
        signal: stop.signal,
        onPhase: () => {
          stop.abort()
        },
      },
      wired.client,
    )
    await assert.rejects(run, /Stopped by you/)
  })

  it('refuses a run whose network access is not what was armed', async () => {
    const dir = scratch()
    let runs = 0
    const wired = inProcess(dir, {
      resolve: () => Promise.resolve(plan(['inference.copse.internal:443', 'evil.example:443'])),
      run: () => {
        runs += 1
        return Promise.resolve(fakeRecord('t1'))
      },
    })
    await assert.rejects(runThroughHost(hostRequest(), {}, wired.client), /network access changed/)
    assert.equal(runs, 0)
  })

  it('leaves ChatGPT plan runs in the app', async () => {
    assert.equal(canHostOutsideApp('claude-sonnet-4-6'), true)
    assert.equal(canHostOutsideApp('chatgpt-plan:client#gpt-5'), false)
    const dir = scratch()
    const wired = inProcess(dir, {
      resolve: () => Promise.reject(new Error('not reached')),
      run: () => Promise.reject(new Error('not reached')),
    })
    await assert.rejects(
      runThroughHost(hostRequest({ model: 'chatgpt-plan:client#gpt-5' }), {}, wired.client),
      /runs in the app/,
    )
  })

  it('lets go of a run without stopping it, and a relaunched app follows it to the end', async () => {
    const dir = scratch()
    let finishRun: (record: ReturnType<typeof fakeRecord>) => void = () => undefined
    let stopped = false
    const wired = inProcess(dir, {
      resolve: () => Promise.resolve(plan()),
      run: (_request, options?: RunThreadOptions) =>
        new Promise((resolve) => {
          options?.signal?.addEventListener('abort', () => {
            stopped = true
          })
          options?.onLog?.('working')
          options?.onPhase?.('running')
          finishRun = resolve
        }),
    })
    const detach = new AbortController()
    const quitting = runThroughHost(
      hostRequest(),
      {
        detach: detach.signal,
        onPhase: () => {
          detach.abort()
        },
      },
      wired.client,
    )
    await assert.rejects(quitting, RunHostDetached)
    assert.equal(stopped, false, 'letting go is not a stop')
    assert.ok(existsSync(wired.hostFile), 'the host is still serving the run')

    const lines: string[] = []
    let caughtUp: () => void = () => undefined
    const replayed = new Promise<void>((resolve) => {
      caughtUp = resolve
    })
    const following = followHost(wired.client.socketPath('run-test-1'), {
      onLog: (line) => {
        lines.push(line)
        caughtUp()
      },
    })
    await replayed
    finishRun(fakeRecord('t1'))
    const record = await following
    assert.equal(record.result?.finalText, 'Done.')
    assert.deepEqual(lines, ['working'], 'the relaunched app gets the log so far')
  })

  it('lists live hosts and clears the files of hosts that died', async () => {
    const dir = scratch()
    const hosts = join(dir, 'container-hosts')
    mkdirSync(hosts)
    const entry = (runtimeId: string, pid: number): string =>
      JSON.stringify({
        pid,
        socket: '/s.sock',
        runtimeId,
        projectId: 'p1',
        display: hostRequest().display,
      })
    writeFileSync(join(hosts, 'run-live.json'), entry('run-live', 100))
    writeFileSync(join(hosts, 'run-dead.json'), entry('run-dead', 200))
    writeFileSync(join(hosts, 'run-junk.json'), '{')
    writeFileSync(join(hosts, 'run-x.request.json'), '{}')
    const live = await listLiveRunHosts(dir, (pid) => pid === 100)
    assert.deepEqual(
      live.map((host) => host.runtimeId),
      ['run-live'],
    )
    assert.equal(existsSync(join(hosts, 'run-dead.json')), false)
    assert.equal(existsSync(join(hosts, 'run-junk.json')), false)
    assert.equal(existsSync(join(hosts, 'run-x.request.json')), true, 'a pending request is kept')
  })

  it('fails when the host exits before it listens', async () => {
    await assert.rejects(
      runThroughHost(
        hostRequest(),
        {},
        {
          writeRequest: () => Promise.resolve('request.json'),
          launch: () => Promise.resolve({ exited: Promise.resolve() }),
          socketPath: () => join(scratch(), 'nobody.sock'),
        },
      ),
      /exited before it started/,
    )
  })
})
