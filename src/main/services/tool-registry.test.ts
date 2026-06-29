import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToolRegistry, setPermissionGateForTests } from './tool-registry.ts'
import { z } from 'zod'

describe('ToolRegistry', () => {
  it('registers and executes a tool', async () => {
    setPermissionGateForTests(async () => true)
    const reg = new ToolRegistry()
    reg.register({
      name: 'echo',
      description: 'echo args',
      parameters: z.object({ msg: z.string() }),
      execute: async ({ msg }) => msg,
    })
    const result = await reg.execute('echo', { msg: 'hello' }, new AbortController().signal)
    assert.equal(result, 'hello')
    setPermissionGateForTests(null)
  })

  it('throws on unknown tool', async () => {
    setPermissionGateForTests(async () => true)
    const reg = new ToolRegistry()
    await assert.rejects(
      () => reg.execute('nope', {}, new AbortController().signal),
      /Unknown tool/,
    )
    setPermissionGateForTests(null)
  })

  it('toLLMTools returns JSON Schema shape', () => {
    setPermissionGateForTests(async () => true)
    const reg = new ToolRegistry()
    reg.register({
      name: 'greet',
      description: 'greet',
      parameters: z.object({ name: z.string().describe('person name') }),
      execute: async () => 'hi',
    })
    const tools = reg.toLLMTools()
    assert.equal(tools.length, 1)
    const [tool] = tools
    assert.ok(tool)
    assert.equal(tool.name, 'greet')
    const properties = tool.parameters['properties']
    assert.ok(properties && typeof properties === 'object' && 'name' in properties)
    setPermissionGateForTests(null)
  })
})
