/**
 * The local adapter's side of R2 (`docs/plans/execution-runtime-security.md`):
 * a brokered execution never receives a raw GitHub token, only a contained
 * command the broker can reach gets a grant, that grant is read-only and
 * admits exactly its own socket, and a command approved outside the sandbox is
 * not brokered.
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
  filesystem: { denyRead: ['/home'], allowRead: ['/repo'], allowWrite: ['/repo'], denyWrite: [] },
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
  let previousConfigDir: string | undefined
  let issued: { readOnly: boolean }[]
  let released: number
  let wrappedConfigs: Partial<SandboxRuntimeConfig>[]

  const broker: LocalGitHubBroker = ({ readOnly }) => {
    issued.push({ readOnly })
    return Promise.resolve({
      env: { GH_CONFIG_DIR: '/grant/dir', GH_TOKEN: 'capability' },
      socketPath: '/grant/dir/broker.sock',
      configDir: '/grant/dir',
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
    previousConfigDir = process.env['GH_CONFIG_DIR']
    process.env['GH_TOKEN'] = CANARY
    // The account's own gh login, which a command outside the sandbox keeps.
    process.env['GH_CONFIG_DIR'] = '/home/me/.config/gh'
    issued = []
    released = 0
    wrappedConfigs = []
  })

  afterEach(() => {
    if (previous === undefined) delete process.env['GH_TOKEN']
    else process.env['GH_TOKEN'] = previous
    if (previousConfigDir === undefined) delete process.env['GH_CONFIG_DIR']
    else process.env['GH_CONFIG_DIR'] = previousConfigDir
  })

  it('leaves today’s environment alone when brokering is off', async () => {
    const execution = await runtime({}).exec(request(false, false))
    const env = await output(execution.child)
    assert.match(env, new RegExp(`GH_TOKEN=${CANARY}`))
    assert.equal(issued.length, 0)
    assert.equal(execution.capabilities.brokeredCredentials, undefined)
  })

  it('does not broker a command outside the sandbox: no grant, no raw token, gh keeps its login', async () => {
    // On macOS too, where a contained command would get a grant.
    const local = runtime({ platform: 'darwin' })
    assert.equal(local.capabilities(request(false, true)).brokeredCredentials, undefined)
    const execution = await local.exec(request(false, true))
    const env = await output(execution.child)
    assert.equal(env.includes(CANARY), false)
    assert.doesNotMatch(env, /GH_TOKEN=/)
    assert.match(env, /GH_CONFIG_DIR=\/home\/me\/\.config\/gh/)
    assert.equal(issued.length, 0)
    assert.equal(execution.capabilities.brokeredCredentials, undefined)
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
    // The grant's gh config sits under the home read deny; only this command may read it.
    assert.deepEqual(wrappedConfigs[0].filesystem?.allowRead, [
      '/repo',
      '/grant/dir',
      '/grant/dir/**',
    ])
    assert.deepEqual(wrappedConfigs[0].filesystem.allowWrite, ['/repo'])
    assert.deepEqual(execution.capabilities.brokeredCredentials, ['github'])
    assert.equal(released, 1)
  })

  it('releases the grant when the spawn fails', async () => {
    await assert.rejects(
      runtime({
        platform: 'darwin',
        spawn: () => {
          throw new Error('spawn failed')
        },
      }).exec(request(true, true)),
      /spawn failed/,
    )
    assert.deepEqual(issued, [{ readOnly: true }])
    assert.equal(released, 1)
  })
})
