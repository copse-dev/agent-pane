import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  agentInputSchemaProblem,
  isAgentInputSchema,
  modelFacingInputSchema,
  objectEnvelopeOf,
  TOOL_SCHEMA_DIALECTS,
} from './tool-input-schema.ts'

describe('agentInputSchemaProblem (#4142)', () => {
  it('accepts a plain top-level object', () => {
    assert.equal(agentInputSchemaProblem({ type: 'object', properties: {} }), null)
    assert.equal(isAgentInputSchema({ type: 'object' }), true)
  })

  it('rejects a schema without type "object" at the top level', () => {
    for (const schema of [
      {},
      { type: 'string' },
      { type: ['object', 'null'] },
      { anyOf: [{ type: 'object' }] },
      { properties: { a: { type: 'string' } } },
    ]) {
      assert.equal(
        agentInputSchemaProblem(schema),
        'its input schema is not a top-level object',
        JSON.stringify(schema),
      )
      assert.equal(isAgentInputSchema(schema), false)
    }
  })

  it('rejects every top-level combinator, even beside type "object"', () => {
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      const schema = { type: 'object', properties: {}, [key]: [] }
      assert.equal(agentInputSchemaProblem(schema), `its input schema has a top-level "${key}"`)
      assert.equal(isAgentInputSchema(schema), false)
    }
  })

  it('leaves combinators below the top level alone', () => {
    const schema = {
      type: 'object',
      properties: { target: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
    }
    assert.equal(isAgentInputSchema(schema), true)
  })

  it('reads own keys only, not inherited ones', () => {
    const inherited: Record<string, unknown> = { type: 'object' }
    Object.setPrototypeOf(inherited, { anyOf: [] })
    assert.equal(isAgentInputSchema(inherited), true)
  })
})

describe('modelFacingInputSchema', () => {
  it('converts zod object parameters in both dialects', () => {
    const tool = { parameters: z.object({ path: z.string(), limit: z.number().optional() }) }
    for (const dialect of TOOL_SCHEMA_DIALECTS) {
      const facing = modelFacingInputSchema(tool, dialect)
      assert.ok('schema' in facing, dialect)
      assert.equal(facing.schema['type'], 'object')
      assert.deepEqual(facing.schema['required'], ['path'])
    }
  })

  it('names the combinator a union would put at the top level', () => {
    const union = {
      parameters: z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]),
    }
    const tagged = {
      parameters: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a') }),
        z.object({ kind: z.literal('b') }),
      ]),
    }
    for (const dialect of TOOL_SCHEMA_DIALECTS) {
      assert.deepEqual(modelFacingInputSchema(union, dialect), {
        problem: 'its input schema is not a top-level object',
      })
      assert.deepEqual(modelFacingInputSchema(tagged, dialect), {
        problem: 'its input schema is not a top-level object',
      })
    }
  })

  it('reports a schema zod cannot convert instead of throwing', () => {
    const facing = modelFacingInputSchema(
      { parameters: z.object({ n: z.string() }).transform((value) => value.n) },
      'draft-2020-12',
    )
    assert.ok('problem' in facing)
    assert.match(facing.problem, /^its parameters can't be converted to JSON Schema \(/)
  })

  it('uses pre-built rawParameters as they are, in both dialects', () => {
    const rawParameters = { type: 'object', properties: { q: { type: 'string' } } }
    for (const dialect of TOOL_SCHEMA_DIALECTS) {
      const facing = modelFacingInputSchema({ parameters: z.unknown(), rawParameters }, dialect)
      assert.ok('schema' in facing)
      assert.equal(facing.schema, rawParameters)
    }
    assert.deepEqual(
      modelFacingInputSchema(
        { parameters: z.unknown(), rawParameters: { type: 'object', oneOf: [] } },
        'openapi-3.0',
      ),
      { problem: 'its input schema has a top-level "oneOf"' },
    )
  })
})

describe('objectEnvelopeOf', () => {
  const deviceId = z.string().regex(/^[a-z]+$/)
  const actions = z.discriminatedUnion('action', [
    z.object({ action: z.literal('list') }),
    z.object({ action: z.literal('apps'), device_id: deviceId }),
    z.object({ action: z.literal('delete'), device_id: z.uuid() }),
    z.object({
      action: z.literal('input'),
      device_id: deviceId,
      input: z.discriminatedUnion('type', [
        z.object({ type: z.literal('tap'), x: z.number() }),
        z.object({ type: z.literal('key'), usage: z.number() }),
      ]),
    }),
  ])

  it('flattens a union of object shapes into one object agents can list', () => {
    const envelope = objectEnvelopeOf(actions)
    assert.equal(isAgentInputSchema(envelope), true)
    assert.equal(Object.hasOwn(envelope, '$schema'), false)
    for (const dialect of TOOL_SCHEMA_DIALECTS) {
      assert.ok(
        'schema' in
          modelFacingInputSchema({ parameters: actions, rawParameters: envelope }, dialect),
      )
    }
  })

  it('turns the discriminator into an enum and requires only what every shape requires', () => {
    const envelope = objectEnvelopeOf(actions)
    assert.deepEqual(envelope['required'], ['action'])
    const properties = envelope['properties']
    assert.ok(properties !== null && typeof properties === 'object')
    assert.deepEqual(Object.keys(properties), ['action', 'device_id', 'input'])
    assert.deepEqual(Reflect.get(properties, 'action'), {
      type: 'string',
      enum: ['list', 'apps', 'delete', 'input'],
    })
  })

  it('keeps each distinct definition of a property, and nested unions as they are', () => {
    const properties = objectEnvelopeOf(actions)['properties']
    assert.ok(properties !== null && typeof properties === 'object')
    const deviceIdSchema: unknown = Reflect.get(properties, 'device_id')
    assert.ok(deviceIdSchema !== null && typeof deviceIdSchema === 'object')
    const variants: unknown = Reflect.get(deviceIdSchema, 'anyOf')
    assert.ok(Array.isArray(variants))
    assert.equal(variants.length, 2, 'the regex id and the uuid stay distinct')
    const input: unknown = Reflect.get(properties, 'input')
    assert.ok(input !== null && typeof input === 'object')
    assert.ok(Object.hasOwn(input, 'oneOf'), 'only the top level has to be a plain object')
  })

  it('treats a plain object as a one-shape union', () => {
    assert.deepEqual(objectEnvelopeOf(z.object({ a: z.string(), b: z.number().optional() })), {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
    })
  })

  it('refuses a union with a member that is not an object shape', () => {
    assert.throws(
      () => objectEnvelopeOf(z.union([z.string(), z.object({ a: z.string() })])),
      /needs parameters made of object shapes/,
    )
    assert.throws(() => objectEnvelopeOf(z.string()), /needs parameters made of object shapes/)
  })
})
