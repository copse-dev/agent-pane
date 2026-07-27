import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToolRegistry, setPermissionGateForTests } from './tool-registry.ts'
import { expectRecord } from '@shared/unknown-value.ts'
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

  // H2 (docs/plans/hooks-and-feature-packs.md): a toolGate hook's injected
  // context is stamped onto the check by the gate; the runner appends it to the
  // tool result so the model reads it in the current turn.
  it('appends a hook-injected system-reminder block to a string result (H2)', async () => {
    setPermissionGateForTests(async (check) => {
      check.injectContext = '<system-reminder>\nremember this\n</system-reminder>'
      return true
    })
    const reg = new ToolRegistry()
    reg.register({
      name: 'echo',
      description: 'echo args',
      parameters: z.object({ msg: z.string() }),
      execute: async ({ msg }) => msg,
    })
    const result = await reg.execute('echo', { msg: 'output' }, new AbortController().signal)
    assert.equal(result, 'output\n\n<system-reminder>\nremember this\n</system-reminder>')
    setPermissionGateForTests(null)
  })

  it('appends injected context to a structured result, preserving edit stats (H2)', async () => {
    setPermissionGateForTests(async (check) => {
      check.injectContext = '<system-reminder>\nnote\n</system-reminder>'
      return true
    })
    const reg = new ToolRegistry()
    reg.register({
      name: 'edit',
      description: 'edit a file',
      parameters: z.object({ path: z.string() }),
      execute: async () => ({ result: 'edited', editStats: { additions: 2, deletions: 1 } }),
    })
    const result = await reg.execute('edit', { path: 'a.ts' }, new AbortController().signal)
    assert.deepEqual(result, {
      result: 'edited\n\n<system-reminder>\nnote\n</system-reminder>',
      editStats: { additions: 2, deletions: 1 },
    })
    setPermissionGateForTests(null)
  })

  it('leaves the result untouched when no context is injected (H2)', async () => {
    setPermissionGateForTests(async () => true)
    const reg = new ToolRegistry()
    reg.register({
      name: 'echo',
      description: 'echo args',
      parameters: z.object({ msg: z.string() }),
      execute: async ({ msg }) => msg,
    })
    const result = await reg.execute('echo', { msg: 'plain' }, new AbortController().signal)
    assert.equal(result, 'plain')
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

  it('toLLMTools emits numeric exclusiveMinimum/Maximum, not the boolean draft-4 form', () => {
    setPermissionGateForTests(async () => true)
    const reg = new ToolRegistry()
    reg.register({
      name: 'bounded',
      description: 'bounded number',
      parameters: z.object({ number: z.number().int().positive().lt(100) }),
      execute: async () => 'ok',
    })
    const [tool] = reg.toLLMTools()
    assert.ok(tool)
    const properties = expectRecord(tool.parameters['properties'])
    const numberSchema = expectRecord(properties['number'])
    // Strict JSON Schema 2020-12 (which some providers validate against, e.g.
    // poolside) requires these to be numbers, not the OpenAPI/draft-4 boolean
    // form paired with `minimum`/`maximum`.
    assert.equal(numberSchema['exclusiveMinimum'], 0)
    assert.equal(numberSchema['exclusiveMaximum'], 100)
    assert.equal(numberSchema['minimum'], undefined)
    assert.equal(numberSchema['maximum'], undefined)
    setPermissionGateForTests(null)
  })
})
