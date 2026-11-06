import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isRecord } from '@copse/std/unknown-value.ts'
import { appleDesktopRequestSchema } from '../../../scripts/lib/apple-desktop-wire.mts'
import { isAgentInputSchema } from '../services/acp/acp-native-bridge.ts'
import { runWithThreadExecutionContext } from '../services/thread-execution-context.ts'
import { ToolRegistry, setPermissionGateForTests } from '../services/tool-registry.ts'
import { createIsolatedDesktopTool, isolatedDesktopTool } from './isolated-desktop-tool.ts'

/** The flat schema agents are shown for isolated_copse. */
function advertisedSchema(): Record<string, unknown> {
  const registry = new ToolRegistry()
  registry.register(isolatedDesktopTool)
  const tool = registry.toMcpTools().find(({ name }) => name === 'isolated_copse')
  assert.ok(tool)
  return tool.inputSchema
}

function advertisedProperties(): Record<string, unknown> {
  const properties = advertisedSchema()['properties']
  assert.ok(isRecord(properties), 'an object schema with properties')
  return properties
}

/** A valid value for every advertised field, as a model filling them all would send. */
const EVERY_FIELD = { model: 'gpt-5', x: 10, y: 20, button: 2, text: '', key: 'Return' }

/** What each action keeps of a call carrying {@link EVERY_FIELD}. */
const KEPT_BY_ACTION = {
  start: { action: 'start', model: 'gpt-5' },
  screenshot: { action: 'screenshot' },
  click: { action: 'click', x: 10, y: 20, button: 2 },
  type: { action: 'type', text: '' },
  key: { action: 'key', key: 'Return' },
  stop: { action: 'stop' },
}

describe('isolated_copse input', () => {
  afterEach(() => {
    setPermissionGateForTests(null)
  })

  it('still advertises a top-level object schema agents accept (#4142)', () => {
    assert.ok(isAgentInputSchema(advertisedSchema()))
  })

  it('advertises exactly the fields some action takes, so only unknown keys are refused', () => {
    const taken = new Set(['action', 'model'])
    for (const shape of appleDesktopRequestSchema.options) {
      for (const field of Object.keys(shape.shape)) taken.add(field)
    }
    assert.deepEqual(Object.keys(advertisedProperties()).sort(), [...taken].sort())
  })

  it('accepts a call that fills every advertised field, keeping only the action’s own', () => {
    const action = advertisedProperties()['action']
    assert.ok(isRecord(action))
    assert.deepEqual(action['enum'], Object.keys(KEPT_BY_ACTION))
    assert.deepEqual(
      Object.keys(advertisedProperties()).sort(),
      ['action', ...Object.keys(EVERY_FIELD)].sort(),
    )
    for (const [name, kept] of Object.entries(KEPT_BY_ACTION)) {
      assert.deepEqual(
        isolatedDesktopTool.parameters.parse({ ...EVERY_FIELD, action: name }),
        kept,
        name,
      )
    }
  })

  it('drops a click’s model before the request reaches the desktop service', async () => {
    const requests: unknown[] = []
    const registry = new ToolRegistry()
    registry.register(
      createIsolatedDesktopTool({
        start: () => Promise.reject(new Error('start is not part of this test')),
        control: (_owner, request) => {
          requests.push(request)
          return Promise.resolve(undefined)
        },
      }),
    )
    setPermissionGateForTests(() => Promise.resolve(true))
    const args = { action: 'click', x: 10, y: 20, model: 'gpt-5' }

    registry.validateArgs('isolated_copse', args)
    const { result } = await runWithThreadExecutionContext(
      {
        projectId: 'project-1',
        threadId: 'desktop-owner',
        projectRoot: process.cwd(),
        root: process.cwd(),
        checkoutMode: 'shared',
        branch: null,
      },
      () => registry.executeNormalized('isolated_copse', args, new AbortController().signal),
    )

    assert.match(result, /Guest input completed\./)
    assert.deepEqual(requests, [{ action: 'click', x: 10, y: 20, button: 1 }])
  })

  it('accepts a screenshot with an empty text', () => {
    const registry = new ToolRegistry()
    registry.register(isolatedDesktopTool)
    registry.validateArgs('isolated_copse', { action: 'screenshot', text: '' })
    assert.deepEqual(isolatedDesktopTool.parameters.parse({ action: 'screenshot', text: '' }), {
      action: 'screenshot',
    })
  })

  it('still refuses a key the advertised schema does not list', () => {
    const registry = new ToolRegistry()
    registry.register(isolatedDesktopTool)
    for (const args of [
      { action: 'screenshot', foo: 1 },
      { action: 'click', x: 10, y: 20, foo: 1 },
      { action: 'start', model: 'gpt-5', foo: 1 },
    ]) {
      assert.throws(() => {
        registry.validateArgs('isolated_copse', args)
      }, /foo/)
    }
  })

  it('still refuses an action’s own field when its value is invalid', () => {
    assert.throws(() => isolatedDesktopTool.parameters.parse({ action: 'key', key: 'Enter' }))
    assert.throws(() => isolatedDesktopTool.parameters.parse({ action: 'click', x: 10 }))
  })
})
