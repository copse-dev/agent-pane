import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { ToolRegistry, setPermissionGateForTests } from '../tool-registry.ts'
import {
  ToolingLocalNativePackRuntimeController,
  type LocalNativePackRuntimeController,
} from './local-native-pack-controller.ts'
import {
  createLocalNativePackTrustRecord,
  discoverLocalNativePack,
  type LocalNativePackCandidate,
} from './local-native-pack.ts'
import type { LocalNativeRegistrations } from './local-native-pack-protocol.ts'

const roots: string[] = []

async function candidate(toolNames = ['personal_judge']): Promise<LocalNativePackCandidate> {
  const root = await mkdtemp(join(tmpdir(), 'copse-local-native-controller-'))
  roots.push(root)
  await mkdir(join(root, 'dist'))
  await writeFile(join(root, 'dist', 'index.mjs'), 'export function activate() {}\n')
  await writeFile(
    join(root, 'copse-pack.json'),
    JSON.stringify({
      name: 'personal.controller-test',
      tools: { native: toolNames },
      localNative: {
        entrypoint: 'dist/index.mjs',
        sdkVersion: 1,
        capabilities: ['native-tools'],
      },
    }),
  )
  return discoverLocalNativePack(root)
}

function fakeRuntime(registrations: LocalNativeRegistrations): LocalNativePackRuntimeController & {
  disables: string[]
} {
  let running = false
  const disables: string[] = []
  return {
    disables,
    enable: (): Promise<void> => {
      running = true
      return Promise.resolve()
    },
    disable: (packId): Promise<void> => {
      running = false
      disables.push(packId)
      return Promise.resolve()
    },
    isRunning: () => running,
    registrations: () => registrations,
    invoke: (_packId, _kind, _registrationId, input) =>
      Promise.resolve({ result: JSON.stringify(input) }),
  }
}

afterEach(async () => {
  setPermissionGateForTests(null)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ToolingLocalNativePackRuntimeController', () => {
  it('registers exact manifest tools, invokes them, and unregisters on disable', async () => {
    const pack = await candidate()
    const runtime = fakeRuntime({
      tools: [
        {
          name: 'personal_judge',
          description: 'Judge an input.',
          inputSchema: { type: 'object' },
        },
      ],
    })
    const registry = new ToolRegistry()
    const controller = new ToolingLocalNativePackRuntimeController(
      registry,
      () => Promise.reject(new Error('unused')),
      runtime,
    )

    await controller.enable(pack, createLocalNativePackTrustRecord(pack))
    assert.equal(registry.has('personal_judge'), true)
    setPermissionGateForTests(() => Promise.resolve(true))
    assert.deepEqual(
      await registry.execute('personal_judge', { prompt: 'review' }, new AbortController().signal),
      { result: '{"prompt":"review"}' },
    )

    await controller.disable(pack.manifest.name)
    assert.equal(registry.has('personal_judge'), false)
    assert.deepEqual(runtime.disables, ['personal.controller-test'])
  })

  it('fails closed and stops the worker when registrations differ from the manifest', async () => {
    const pack = await candidate(['declared_tool'])
    const runtime = fakeRuntime({
      tools: [{ name: 'other_tool', description: 'Unexpected.', inputSchema: {} }],
    })
    const controller = new ToolingLocalNativePackRuntimeController(
      new ToolRegistry(),
      () => Promise.reject(new Error('unused')),
      runtime,
    )

    await assert.rejects(
      controller.enable(pack, createLocalNativePackTrustRecord(pack)),
      /registered tools not shown in its manifest/,
    )
    assert.deepEqual(runtime.disables, ['personal.controller-test'])
  })
})
