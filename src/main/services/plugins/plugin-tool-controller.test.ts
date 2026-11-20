import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { ToolRegistry, setPermissionGateForTests } from '../tool-registry.ts'
import {
  DefaultPluginToolRuntimeController,
  ToolingPluginToolRuntimeController,
  type PluginToolRuntimeController,
  type PluginToolWorker,
} from './plugin-tool-controller.ts'
import { discoverPluginToolSource, type PluginToolSourceCandidate } from './plugin-tool-source.ts'
import type { PluginToolRegistrations } from './plugin-tool-protocol.ts'

const roots: string[] = []

async function candidate(toolNames = ['personal_judge']): Promise<PluginToolSourceCandidate> {
  const root = await mkdtemp(join(tmpdir(), 'copse-plugin-tool-controller-'))
  roots.push(root)
  await mkdir(join(root, 'dist'))
  await writeFile(join(root, 'dist', 'index.mjs'), 'export function activate() {}\n')
  await writeFile(
    join(root, 'copse-plugin.json'),
    JSON.stringify({
      name: 'personal.controller-test',
      tools: {
        provides: toolNames,
      },
      runtime: { entrypoint: 'dist/index.mjs', apiVersion: 1 },
    }),
  )
  return discoverPluginToolSource(root)
}

async function modelCandidate(): Promise<PluginToolSourceCandidate> {
  const root = await mkdtemp(join(tmpdir(), 'copse-plugin-model-controller-'))
  roots.push(root)
  await mkdir(join(root, 'dist'))
  await writeFile(join(root, 'dist', 'index.mjs'), 'export function activate() {}\n')
  await writeFile(
    join(root, 'copse-plugin.json'),
    JSON.stringify({
      name: 'personal.controller-model',
      models: { provides: [{ id: 'judge', label: 'Judge' }] },
      runtime: { entrypoint: 'dist/index.mjs', apiVersion: 1 },
    }),
  )
  return discoverPluginToolSource(root)
}

function fakeRuntime(registrations: PluginToolRegistrations): PluginToolRuntimeController & {
  disables: string[]
  crash: () => void
} {
  let running = false
  const disables: string[] = []
  return {
    disables,
    crash: (): void => {
      running = false
    },
    enable: (): Promise<void> => {
      running = true
      return Promise.resolve()
    },
    disable: (pluginId): Promise<void> => {
      running = false
      disables.push(pluginId)
      return Promise.resolve()
    },
    isRunning: () => running,
    registrations: () => registrations,
    invokeTool: (_pluginId, _registrationId, input) =>
      Promise.resolve({ result: JSON.stringify(input) }),
    invokeModel: (_pluginId, _registrationId, input) => Promise.resolve(input),
    invokeHook: (_pluginId, _registrationId, _event, input) => Promise.resolve(input),
  }
}

afterEach(async () => {
  setPermissionGateForTests(null)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ToolingPluginToolRuntimeController', () => {
  it('stops a worker with undeclared hook registrations before exposing its tools', async () => {
    const plugin = await candidate()
    const runtime = fakeRuntime({
      tools: [{ name: 'personal_judge', description: 'Judge', inputSchema: {} }],
      models: [],
      hooks: [{ id: 'unexpected', event: 'toolGate' }],
    })
    const registry = new ToolRegistry()
    const controller = new ToolingPluginToolRuntimeController(registry, runtime)
    await assert.rejects(controller.enable(plugin), /hooks not declared/)
    assert.equal(registry.has('personal_judge'), false)
    assert.deepEqual(runtime.disables, ['personal.controller-test'])
  })
  it('registers exact declared tools, invokes them, and unregisters on disable', async () => {
    const plugin = await candidate()
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
    const controller = new ToolingPluginToolRuntimeController(registry, runtime)

    await controller.enable(plugin)
    assert.equal(registry.has('personal_judge'), true)
    setPermissionGateForTests(() => Promise.resolve(true))
    assert.deepEqual(
      await registry.execute('personal_judge', { prompt: 'review' }, new AbortController().signal),
      { result: '{"prompt":"review"}' },
    )

    await controller.disable(plugin.manifest.name)
    assert.equal(registry.has('personal_judge'), false)
    assert.deepEqual(runtime.disables, ['personal.controller-test'])
  })

  it('fails closed and stops the worker when registrations differ from the manifest', async () => {
    const plugin = await candidate(['declared_tool'])
    const runtime = fakeRuntime({
      tools: [{ name: 'other_tool', description: 'Unexpected.', inputSchema: {} }],
      models: [],
    })
    const controller = new ToolingPluginToolRuntimeController(new ToolRegistry(), runtime)

    await assert.rejects(controller.enable(plugin), /registered tools not declared/i)
    assert.deepEqual(runtime.disables, ['personal.controller-test'])
  })

  it('fails closed when model handlers differ from the manifest', async () => {
    const plugin = await modelCandidate()
    const runtime = fakeRuntime({ tools: [], models: [{ id: 'other' }] })
    const controller = new ToolingPluginToolRuntimeController(new ToolRegistry(), runtime)

    await assert.rejects(controller.enable(plugin), /registered models not declared/i)
    assert.deepEqual(runtime.disables, ['personal.controller-model'])
  })

  it('accepts an exact declared model handler without adding a tool', async () => {
    const plugin = await modelCandidate()
    const runtime = fakeRuntime({ tools: [], models: [{ id: 'judge' }] })
    const registry = new ToolRegistry()
    const controller = new ToolingPluginToolRuntimeController(registry, runtime)

    await controller.enable(plugin)
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

  it('starts a plugin again after its worker died, without tripping over its own tools', async () => {
    const plugin = await candidate()
    const runtime = fakeRuntime({
      tools: [{ name: 'personal_judge', description: 'Judge', inputSchema: {} }],
      models: [],
    })
    const registry = new ToolRegistry()
    const controller = new ToolingPluginToolRuntimeController(registry, runtime)
    await controller.enable(plugin)
    // The worker exits on its own: nothing unregistered the tools it served.
    runtime.crash()

    await controller.enable(plugin)

    assert.equal(runtime.isRunning(plugin.manifest.name), true)
    assert.equal(registry.has('personal_judge'), true)
    assert.deepEqual(runtime.disables, [])
  })

  it("still counts a dead worker's tools as something to disable", async () => {
    const plugin = await candidate()
    const runtime = fakeRuntime({
      tools: [{ name: 'personal_judge', description: 'Judge', inputSchema: {} }],
      models: [],
    })
    const registry = new ToolRegistry()
    const controller = new ToolingPluginToolRuntimeController(registry, runtime)
    await controller.enable(plugin)
    runtime.crash()

    // Turning the plugin off disables only what `isRunning` reports.
    assert.equal(controller.isRunning(plugin.manifest.name), true)
    await controller.disable(plugin.manifest.name)

    assert.equal(registry.has('personal_judge'), false)
    assert.equal(controller.isRunning(plugin.manifest.name), false)
  })
})

describe('DefaultPluginToolRuntimeController', () => {
  function worker(): PluginToolWorker & { die: () => void; stopped: boolean } {
    let running = true
    const self = {
      stopped: false,
      get running(): boolean {
        return running
      },
      die: (): void => {
        running = false
      },
      registrations: { tools: [], models: [] },
      stop: (): Promise<void> => {
        running = false
        self.stopped = true
        return Promise.resolve()
      },
      invokeTool: (): Promise<unknown> =>
        running
          ? Promise.resolve('ok')
          : Promise.reject(new Error('Plugin tools are not running.')),
      invokeHook: (): Promise<unknown> => Promise.resolve(null),
      invokeModel: (): Promise<unknown> => Promise.resolve(null),
    }
    return self
  }

  it('reports a dead worker as not running and replaces it on the next enable', async () => {
    const plugin = await candidate()
    const id = plugin.manifest.name
    const started: ReturnType<typeof worker>[] = []
    const controller = new DefaultPluginToolRuntimeController(() => {
      const next = worker()
      started.push(next)
      return Promise.resolve(next)
    })

    await controller.enable(plugin)
    assert.equal(controller.isRunning(id), true)
    await controller.enable(plugin)
    assert.equal(started.length, 1)

    // The worker process exits (a crash, an OOM kill): the plugin is not
    // running, and enabling it must start a fresh worker rather than keep
    // routing every call to the dead one.
    started[0]?.die()
    assert.equal(controller.isRunning(id), false)
    await controller.enable(plugin)

    assert.equal(started.length, 2)
    assert.equal(controller.isRunning(id), true)
    assert.equal(await controller.invokeTool(id, 'personal_judge', {}), 'ok')
  })
})
