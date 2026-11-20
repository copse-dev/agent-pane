import assert from 'node:assert/strict'
import { it } from 'node:test'
import { normalizeOpenAIToolSchema } from './normalize-tool-schema.ts'

it('exposes object union fields and shared requirements without removing branch validation', () => {
  const branches = [
    {
      type: 'object',
      properties: { action: { const: 'list' } },
      required: ['action'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { action: { const: 'launch' }, device: { type: 'string' } },
      required: ['action', 'device'],
      additionalProperties: false,
    },
  ]
  const schema = { oneOf: branches }
  assert.deepEqual(normalizeOpenAIToolSchema(schema), {
    type: 'object',
    oneOf: branches,
    properties: {
      action: { anyOf: [{ const: 'list' }, { const: 'launch' }] },
      device: { type: 'string' },
    },
    required: ['action'],
  })
  assert.deepEqual(Object.keys(schema), ['oneOf'])
})

it('does not constrain a field accepted freely by another union branch', () => {
  const schema = {
    anyOf: [
      { type: 'object', properties: {}, additionalProperties: true },
      {
        type: 'object',
        properties: { value: { type: 'integer' } },
        required: ['value'],
        additionalProperties: false,
      },
    ],
  }
  const normalized = normalizeOpenAIToolSchema(schema)
  assert.deepEqual(normalized['properties'], { value: {} })
  assert.deepEqual(normalized['required'], [])
  assert.deepEqual(normalized['anyOf'], schema.anyOf)
})

it('exposes fields from nested object unions while preserving the original alternatives', () => {
  const schema = {
    anyOf: [
      {
        type: 'object',
        properties: { action: { const: 'start' } },
        required: ['action'],
        additionalProperties: false,
      },
      {
        oneOf: [
          {
            type: 'object',
            properties: { action: { const: 'click' }, x: { type: 'integer' } },
            required: ['action', 'x'],
            additionalProperties: false,
          },
          {
            anyOf: [
              {
                type: 'object',
                properties: { action: { const: 'stop' } },
                required: ['action'],
                additionalProperties: false,
              },
            ],
          },
        ],
      },
    ],
  }
  const normalized = normalizeOpenAIToolSchema(schema)
  assert.equal(normalized['type'], 'object')
  assert.deepEqual(normalized['properties'], {
    action: { anyOf: [{ const: 'start' }, { const: 'click' }, { const: 'stop' }] },
    x: { type: 'integer' },
  })
  assert.deepEqual(normalized['required'], ['action'])
  assert.deepEqual(normalized['anyOf'], schema.anyOf)
  assert.deepEqual(Object.keys(schema), ['anyOf'])
  assert.deepEqual(normalizeOpenAIToolSchema(schema, { objectUnionEnvelope: false }), schema)
})

it('does not infer an object envelope when a nested alternative accepts a scalar', () => {
  const schema = {
    anyOf: [
      { type: 'object', properties: {} },
      { oneOf: [{ type: 'object', properties: {} }, { type: 'string' }] },
    ],
  }
  assert.deepEqual(normalizeOpenAIToolSchema(schema), schema)
})

it('leaves scalar and nested unions unchanged while normalizing legacy bounds', () => {
  const scalar = { anyOf: [{ type: 'string' }, { type: 'number' }] }
  assert.deepEqual(normalizeOpenAIToolSchema(scalar), scalar)
  const nested = {
    type: 'object',
    properties: {
      value: {
        anyOf: [
          { type: 'object', properties: {} },
          { type: 'object', properties: { x: { type: 'string' } } },
        ],
      },
      count: { type: 'integer', minimum: 0, exclusiveMinimum: true },
    },
  }
  const normalized = normalizeOpenAIToolSchema(nested)
  assert.deepEqual(normalized, {
    ...nested,
    properties: { ...nested.properties, count: { type: 'integer', exclusiveMinimum: 0 } },
  })
})

it('preserves root unions when qualifying a strict schema', () => {
  const schema = {
    oneOf: [{ type: 'object', properties: {}, required: [], additionalProperties: false }],
  }
  assert.deepEqual(normalizeOpenAIToolSchema(schema, { objectUnionEnvelope: false }), schema)
})

it('keeps fields accepted by a patterned branch available in the object envelope', () => {
  const schema = {
    oneOf: [
      {
        type: 'object',
        patternProperties: { '^value$': { type: 'string' } },
        additionalProperties: false,
      },
      { type: 'object', properties: { value: { type: 'integer' } }, additionalProperties: false },
    ],
  }
  const normalized = normalizeOpenAIToolSchema(schema)
  assert.deepEqual(normalized['properties'], { value: {} })
  assert.deepEqual(normalized['oneOf'], schema.oneOf)
})
