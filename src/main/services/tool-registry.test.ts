import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToolRegistry } from './tool-registry.ts'
import { z } from 'zod'

describe('ToolRegistry', () => {
  it('registers and executes a tool', async () => {
    const reg = new ToolRegistry()
    reg.register({
      name: 'echo',
      description: 'echo args',
      parameters: z.object({ msg: z.string() }),
      execute: async ({ msg }) => msg,
    })
    const result = await reg.execute('echo', { msg: 'hello' }, new AbortController().signal)
    assert.equal(result, 'hello')
  })

  it('throws on unknown tool', async () => {
    const reg = new ToolRegistry()
    await assert.rejects(
      () => reg.execute('nope', {}, new AbortController().signal),
      /Unknown tool/,
    )
  })

  it('toLLMTools returns JSON Schema shape', () => {
    const reg = new ToolRegistry()
    reg.register({
      name: 'greet',
      description: 'greet',
      parameters: z.object({ name: z.string().describe('person name') }),
      execute: async () => 'hi',
    })
    const tools = reg.toLLMTools()
    assert.equal(tools.length, 1)
    assert.equal(tools[0]!.name, 'greet')
    assert.ok((tools[0]!.parameters as any).properties?.name)
  })
})
