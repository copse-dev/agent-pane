import { it } from 'node:test'
import assert from 'node:assert/strict'
import { isRecord } from '@copse/std/unknown-value.ts'
import { prepareStrictTools } from '@copse/llm/strict-tool-schema.ts'
import { APPLE_DESKTOP_KEY_PATTERN } from '../../../scripts/lib/apple-desktop-wire.mts'
import { isAgentInputSchema } from '../services/acp/acp-native-bridge.ts'
import { ToolRegistry } from '../services/tool-registry.ts'
import { isolatedDesktopTool } from './isolated-desktop-tool.ts'

function advertisedKeyPattern(schema: unknown): string {
  assert.ok(isRecord(schema) && isRecord(schema['properties']), 'an object schema')
  const key = schema['properties']['key']
  assert.ok(isRecord(key) && typeof key['pattern'] === 'string', 'key advertises a pattern')
  return key['pattern']
}

function registryWithIsolatedDesktop(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(isolatedDesktopTool)
  return registry
}

it('advertises the key pattern the guest wire enforces, so the model sees it before calling', () => {
  const registry = registryWithIsolatedDesktop()
  const tool = registry.toMcpTools().find(({ name }) => name === 'isolated_copse')
  assert.ok(tool)
  assert.ok(isAgentInputSchema(tool.inputSchema), 'still a top-level object schema (#4142)')
  const pattern = advertisedKeyPattern(tool.inputSchema)
  assert.equal(pattern, APPLE_DESKTOP_KEY_PATTERN.source)

  // JSON Schema `pattern` is an unanchored ECMA-262 regex, as validators compile it.
  const advertised = new RegExp(pattern, 'u')
  for (const key of ['Return', 'ctrl+c', 'ctrl+shift+Tab', 'F12']) {
    assert.ok(advertised.test(key), `${key} is advertised`)
    registry.validateArgs('isolated_copse', { action: 'key', key })
  }
  assert.equal(advertised.test('Enter'), false)
  assert.throws(() => {
    registry.validateArgs('isolated_copse', { action: 'key', key: 'Enter' })
  })
})

it('keeps the key pattern through the OpenAI strict tool schema', () => {
  const [wire] = prepareStrictTools(registryWithIsolatedDesktop().toLLMTools(), true).tools
  assert.ok(wire)
  assert.equal(wire.strict, true)
  assert.equal(advertisedKeyPattern(wire.parameters), APPLE_DESKTOP_KEY_PATTERN.source)
})
