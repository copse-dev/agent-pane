import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { ToolRegistry, setPermissionGateForTests } from '../tool-registry.ts'
import {
  ToolingPackToolRuntimeController,
  type PackToolRuntimeController,
} from './pack-tool-controller.ts'
import { discoverPackToolSource, type PackToolSourceCandidate } from './pack-tool-source.ts'
import type { PackToolRegistrations } from './pack-tool-protocol.ts'

const roots: string[] = []

async function candidate(toolNames = ['personal_judge']): Promise<PackToolSourceCandidate> {
  const root = await mkdtemp(join(tmpdir(), 'copse-pack-tool-controller-'))
  roots.push(root)
  await mkdir(join(root, 'dist'))
  await writeFile(join(root, 'dist', 'index.mjs'), 'export function activate() {}\n')
  await writeFile(
    join(root, 'copse-pack.json'),
    JSON.stringify({
      name: 'personal.controller-test',
      tools: {
        provides: toolNames,
      },
      runtime: { entrypoint: 'dist/index.mjs', apiVersion: 1 },
    }),
  )
  return discoverPackToolSource(root)
}

async function modelCandidate(): Promise<PackToolSourceCandidate> {
  const root = await mkdtemp(join(tmpdir(), 'copse-pack-model-controller-'))
  roots.push(root)
  await mkdir(join(root, 'dist'))
  await writeFile(join(root, 'dist', 'index.mjs'), 'export function activate() {}\n')
  await writeFile(
    join(root, 'copse-pack.json'),
    JSON.stringify({
      name: 'personal.controller-model',
      models: { provides: [{ id: 'judge', label: 'Judge' }] },
      runtime: { entrypoint: 'dist/index.mjs', apiVersion: 1 },
    }),
  )
  return discoverPackToolSource(root)
}

function fakeRuntime(registrations: PackToolRegistrations): PackToolRuntimeController & {
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
    invokeTool: (_packId, _registrationId, input) =>
      Promise.resolve({ result: JSON.stringify(input) }),
    invokeModel: (_packId, _registrationId, input) => Promise.resolve(input),
  }
}

afterEach(async () => {
  setPermissionGateForTests(null)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ToolingPackToolRuntimeController', () => {
  it('registers exact declared tools, invokes them, and unregisters on disable', async () => {
    const pack = await candidate()
    const runtime = fakeRuntime({
      tools: [
        {
          name: 'personal_judge',
          description: 'Judge an input.',
          inputSchema: { type: 'object' },
        },
      ],
      models: [],
    })
    const registry = new ToolRegistry()
    const controller = new ToolingPackToolRuntimeController(registry, runtime)

    await controller.enable(pack)
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
      models: [],
    })
    const controller = new ToolingPackToolRuntimeController(new ToolRegistry(), runtime)

    await assert.rejects(controller.enable(pack), /registered tools not declared/i)
    assert.deepEqual(runtime.disables, ['personal.controller-test'])
  })

  it('fails closed when model handlers differ from the manifest', async () => {
    const pack = await modelCandidate()
    const runtime = fakeRuntime({ tools: [], models: [{ id: 'other' }] })
    const controller = new ToolingPackToolRuntimeController(new ToolRegistry(), runtime)

    await assert.rejects(controller.enable(pack), /registered models not declared/i)
    assert.deepEqual(runtime.disables, ['personal.controller-model'])
  })

  it('accepts an exact declared model handler without adding a tool', async () => {
    const pack = await modelCandidate()
    const runtime = fakeRuntime({ tools: [], models: [{ id: 'judge' }] })
    const registry = new ToolRegistry()
    const controller = new ToolingPackToolRuntimeController(registry, runtime)

    await controller.enable(pack)
    assert.equal(registry.toLLMTools().length, 0)
    assert.deepEqual(
      await controller.invokeModel('personal.controller-model', 'judge', {
        threadId: 'thread-1',
        prompt: 'review',
        attachments: [],
        history: [],
      }),
      {
        threadId: 'thread-1',
        prompt: 'review',
        attachments: [],
        history: [],
      },
    )
  })
})
