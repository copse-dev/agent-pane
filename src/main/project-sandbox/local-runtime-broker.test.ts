/**
 * The local adapter's side of R2 (`docs/plans/execution-runtime-security.md`):
 * a brokered execution never receives a raw GitHub token, gets a grant only
 * where the broker can be reached, and a contained grant is read-only and
 * admits exactly its own socket.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import type { RuntimeExecRequest } from '../services/execution-runtime/runtime.ts'
import {
  createLocalExecutionRuntime,
  type LocalGitHubBroker,
  type LocalRuntimeDependencies,
} from './local-runtime.ts'

const CANARY = 'ghp_CANARYcanaryCANARYcanary0123456789'
const CONTAINED_CONFIG: Partial<SandboxRuntimeConfig> = {
  network: { allowedDomains: [], deniedDomains: [] },
}

function output(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', () => {
      resolve(stdout)
    })
  })
}

function request(sandbox: boolean, brokered: boolean): RuntimeExecRequest {
  return {
    // Print every GitHub-ish variable the child can see.
    command: { kind: 'shell', commandLine: 'env | grep -E "^(GH_|GITHUB_)" || true' },
    cwd: tmpdir(),
    stdio: 'pipe',
    // A caller overlay cannot put a token back either.
    env: { GITHUB_TOKEN: CANARY },
    local: {
      sandbox,
      brokerGitHubCredentials: brokered,
      plan: () => ({ config: CONTAINED_CONFIG }),
    },
  }
}

describe('local runtime GitHub brokering', () => {
  let previous: string | undefined
  let issued: { readOnly: boolean }[]
  let released: number
  let wrappedConfigs: Partial<SandboxRuntimeConfig>[]

  const broker: LocalGitHubBroker = ({ readOnly }) => {
    issued.push({ readOnly })
    return Promise.resolve({
      env: { GH_CONFIG_DIR: '/grant/dir', GH_TOKEN: 'capability' },
      socketPath: '/grant/dir/broker.sock',
      release: () => {
        released += 1
        return Promise.resolve()
      },
    })
  }

  function runtime(
    overrides: Partial<LocalRuntimeDependencies>,
  ): ReturnType<typeof createLocalExecutionRuntime> {
    return createLocalExecutionRuntime({
      spawn: (file, args, options) => spawn(file, [...args], options),
      wrapWithSandboxArgv: (command, _shell, config) => {
        wrappedConfigs.push(config ?? {})
        return Promise.resolve({ argv: ['/bin/sh', '-c', command], env: process.env })
      },
      isSandboxEnabled: () => true,
      isSpawnableWorkingDirectory: () => Promise.resolve(true),
      releaseSandboxLease: () => {},
      brokerGitHub: broker,
      platform: 'linux',
      ...overrides,
    })
  }

  beforeEach(() => {
    previous = process.env['GH_TOKEN']
    process.env['GH_TOKEN'] = CANARY
    issued = []
    released = 0
    wrappedConfigs = []
  })

  afterEach(() => {
    if (previous === undefined) delete process.env['GH_TOKEN']
    else process.env['GH_TOKEN'] = previous
  })

  it('leaves today’s environment alone when brokering is off', async () => {
    const execution = await runtime({}).exec(request(false, false))
    const env = await output(execution.child)
    assert.match(env, new RegExp(`GH_TOKEN=${CANARY}`))
    assert.equal(issued.length, 0)
    assert.equal(execution.capabilities.brokeredCredentials, undefined)
  })

  it('gives a command outside the sandbox a full grant and no raw token', async () => {
    const execution = await runtime({}).exec(request(false, true))
    const env = await output(execution.child)
    assert.equal(env.includes(CANARY), false)
    assert.match(env, /GH_CONFIG_DIR=\/grant\/dir/)
    assert.match(env, /GH_TOKEN=capability/)
    assert.deepEqual(issued, [{ readOnly: false }])
    assert.deepEqual(execution.capabilities.brokeredCredentials, ['github'])
    assert.equal(released, 1)
  })

  it('strips the token from a contained Linux command without a grant it cannot reach', async () => {
    const execution = await runtime({ platform: 'linux' }).exec(request(true, true))
    const env = await output(execution.child)
    assert.equal(env.includes(CANARY), false)
    assert.equal(issued.length, 0)
    assert.equal(execution.capabilities.brokeredCredentials, undefined)
    assert.equal(wrappedConfigs[0]?.network?.allowUnixSockets, undefined)
  })

  it('gives a contained macOS command a read-only grant and admits only its socket', async () => {
    const execution = await runtime({ platform: 'darwin' }).exec(request(true, true))
    const env = await output(execution.child)
    assert.equal(env.includes(CANARY), false)
    assert.deepEqual(issued, [{ readOnly: true }])
    assert.deepEqual(wrappedConfigs[0]?.network?.allowUnixSockets, ['/grant/dir/broker.sock'])
    assert.deepEqual(execution.capabilities.brokeredCredentials, ['github'])
    assert.equal(released, 1)
  })

  it('releases the grant when the spawn fails', async () => {
    await assert.rejects(
      runtime({
        spawn: () => {
          throw new Error('spawn failed')
        },
      }).exec(request(false, true)),
      /spawn failed/,
    )
    assert.equal(released, 1)
  })
})
