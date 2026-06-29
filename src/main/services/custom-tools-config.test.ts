import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCustomTool, customToolName, customToolLabel } from './custom-tools-config.ts'

const signal = new AbortController().signal

describe('normalizeCustomTool', () => {
  it('wraps a valid definition with a prefixed name and sanitized schema', async () => {
    const { tool, error } = normalizeCustomTool({
      name: 'echo',
      description: 'Echo a message',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
      execute: ({ msg }: { msg: string }) => `got ${msg}`,
    })
    assert.equal(error, undefined)
    assert.ok(tool)
    assert.equal(tool.name, 'custom__echo')
    assert.match(tool.description, /^\[custom\] /)
    assert.equal((tool.rawParameters as { type: string }).type, 'object')
    assert.equal(await tool.execute({ msg: 'hi' }, signal), 'got hi')
  })

  it('accepts `parameters` as an alias for inputSchema and defaults a missing schema', () => {
    const withAlias = normalizeCustomTool({
      name: 'a',
      parameters: { type: 'object', properties: { x: { type: 'number' } } },
      execute: () => 'ok',
    })
    assert.equal((withAlias.tool!.rawParameters as { type: string }).type, 'object')

    const noSchema = normalizeCustomTool({ name: 'b', execute: () => 'ok' })
    assert.deepEqual(noSchema.tool!.rawParameters, { type: 'object', properties: {} })
  })

  it('coerces non-string return values: JSON for objects, "" for nullish', async () => {
    const json = normalizeCustomTool({ name: 'j', execute: () => ({ a: 1 }) }).tool!
    assert.equal(await json.execute({}, signal), '{"a":1}')

    const nullish = normalizeCustomTool({ name: 'n', execute: () => undefined }).tool!
    assert.equal(await nullish.execute({}, signal), '')

    const num = normalizeCustomTool({ name: 'm', execute: () => 42 }).tool!
    assert.equal(await num.execute({}, signal), '42')
  })

  it('flattens an MCP-style envelope and throws on isError', async () => {
    const ok = normalizeCustomTool({
      name: 'env',
      execute: () => ({ content: [{ type: 'text', text: 'hello' }] }),
    }).tool!
    assert.equal(await ok.execute({}, signal), 'hello')

    const bad = normalizeCustomTool({
      name: 'envbad',
      execute: () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }),
    }).tool!
    await assert.rejects(async () => bad.execute({}, signal), /boom/)
  })

  it('passes requiresApproval through only when explicitly true', () => {
    assert.equal(
      normalizeCustomTool({ name: 'r', requiresApproval: true, execute: () => 'x' }).tool!
        .requiresApproval,
      true,
    )
    assert.equal(
      normalizeCustomTool({ name: 'r2', execute: () => 'x' }).tool!.requiresApproval,
      undefined,
    )
  })

  it('rejects malformed definitions with an error and no tool', () => {
    assert.match(normalizeCustomTool({ execute: () => 'x' }).error!, /missing or empty "name"/)
    assert.match(
      normalizeCustomTool({ name: 'bad name', execute: () => 'x' }).error!,
      /invalid name/,
    )
    assert.match(normalizeCustomTool({ name: 'noexec' }).error!, /missing an "execute"/)
    for (const r of [
      { execute: (): string => 'x' },
      { name: 'bad name', execute: (): string => 'x' },
      { name: 'noexec' },
    ]) {
      assert.equal(normalizeCustomTool(r).tool, undefined)
    }
  })
})

describe('custom tool naming', () => {
  it('round-trips name <-> label through the prefix', () => {
    assert.equal(customToolName('foo'), 'custom__foo')
    assert.equal(customToolLabel('custom__foo'), 'foo')
    assert.equal(customToolLabel('not_prefixed'), 'not_prefixed')
  })
})
