import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyStrictSchema,
  prepareStrictTools,
  restoreAbsentOptionals,
  strictCompatibleSchema,
  toStrictSchema,
} from './strict-tool-schema.ts'

const strictObject = {
  type: 'object',
  properties: { path: { type: 'string' }, recursive: { type: ['boolean', 'null'] } },
  required: ['path', 'recursive'],
  additionalProperties: false,
}

function converted(schema: unknown): Record<string, unknown> {
  const result = toStrictSchema(schema)
  assert.ok(result.ok, result.ok ? '' : result.reasons.join('; '))
  return result.schema
}

describe('strictCompatibleSchema', () => {
  it('accepts a schema that is already strict', () => {
    assert.equal(strictCompatibleSchema(strictObject), true)
    assert.deepEqual(classifyStrictSchema(strictObject), { kind: 'as-is' })
  })

  it('accepts a no-argument tool', () => {
    const schema = { type: 'object', properties: {}, required: [], additionalProperties: false }
    assert.equal(strictCompatibleSchema(schema), true)
  })

  it('does not accept an object with an optional property as-is, but it is convertible', () => {
    const schema = {
      type: 'object',
      properties: { path: { type: 'string' }, line: { type: 'integer' } },
      required: ['path'],
      additionalProperties: false,
    }
    assert.equal(strictCompatibleSchema(schema), false)
    const verdict = classifyStrictSchema(schema)
    assert.equal(verdict.kind, 'convertible')
  })

  it('rejects a union at the root', () => {
    const schema = {
      oneOf: [
        { type: 'object', properties: {}, required: [], additionalProperties: false },
        { type: 'object', properties: {}, required: [], additionalProperties: false },
      ],
    }
    const verdict = classifyStrictSchema(schema)
    assert.equal(verdict.kind, 'incompatible')
  })

  it('rejects open-ended objects and records', () => {
    for (const additionalProperties of [true, { type: 'string' }]) {
      const schema = { type: 'object', properties: {}, additionalProperties }
      assert.equal(classifyStrictSchema(schema).kind, 'incompatible')
    }
    const nested = {
      type: 'object',
      properties: { env: { type: 'object', additionalProperties: { type: 'string' } } },
      required: ['env'],
      additionalProperties: false,
    }
    assert.equal(classifyStrictSchema(nested).kind, 'incompatible')
  })

  it('rejects keywords strict mode cannot express', () => {
    for (const keyword of ['allOf', 'not', 'patternProperties', '$ref', 'if']) {
      const schema = {
        type: 'object',
        properties: { a: { type: 'string', [keyword]: [] } },
        required: ['a'],
        additionalProperties: false,
      }
      const verdict = classifyStrictSchema(schema)
      assert.equal(verdict.kind, 'incompatible', keyword)
    }
  })

  it('rejects a property with no type and an array with no items', () => {
    const untyped = {
      type: 'object',
      properties: { a: {} },
      required: ['a'],
      additionalProperties: false,
    }
    const noItems = {
      type: 'object',
      properties: { a: { type: 'array' } },
      required: ['a'],
      additionalProperties: false,
    }
    assert.equal(classifyStrictSchema(untyped).kind, 'incompatible')
    assert.equal(classifyStrictSchema(noItems).kind, 'incompatible')
  })

  it('rejects objects nested deeper than strict mode allows', () => {
    let schema: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 11; i++) {
      schema = {
        type: 'object',
        properties: { next: schema },
        required: ['next'],
        additionalProperties: false,
      }
    }
    assert.equal(classifyStrictSchema(schema).kind, 'incompatible')
  })

  it('reports every reason, with paths', () => {
    const schema = {
      type: 'object',
      properties: { a: { allOf: [] }, b: { not: {} } },
      required: ['a', 'b'],
      additionalProperties: false,
    }
    const result = toStrictSchema(schema)
    assert.ok(!result.ok)
    assert.equal(result.reasons.length, 2)
    assert.match(result.reasons.join('\n'), /properties\/a/)
    assert.match(result.reasons.join('\n'), /properties\/b/)
  })
})

describe('toStrictSchema', () => {
  it('makes optional properties required and nullable, and does not mutate the input', () => {
    const input = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start_line: { type: 'integer', minimum: 1 },
      },
      required: ['path'],
      additionalProperties: false,
    }
    const before = structuredClone(input)
    assert.deepEqual(converted(input), {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start_line: { type: ['integer', 'null'], minimum: 1 },
      },
      required: ['path', 'start_line'],
      additionalProperties: false,
    })
    assert.deepEqual(input, before)
  })

  it('adds additionalProperties: false to an object that omits it', () => {
    const out = converted({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    })
    assert.equal(out['additionalProperties'], false)
  })

  it('converts nested objects and arrays of objects', () => {
    const out = converted({
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: { content: { type: 'string' }, id: { type: 'string' } },
            required: ['content'],
            additionalProperties: false,
          },
        },
        options: {
          type: 'object',
          properties: { deep: { type: 'boolean' } },
          additionalProperties: false,
        },
      },
      required: ['todos'],
      additionalProperties: false,
    })
    assert.deepEqual(out, {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: { content: { type: 'string' }, id: { type: ['string', 'null'] } },
            required: ['content', 'id'],
            additionalProperties: false,
          },
        },
        options: {
          type: ['object', 'null'],
          properties: { deep: { type: ['boolean', 'null'] } },
          required: ['deep'],
          additionalProperties: false,
        },
      },
      required: ['todos', 'options'],
      additionalProperties: false,
    })
  })

  it('keeps enums and leaves already-nullable optionals alone', () => {
    const out = converted({
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['a', 'b'] },
        note: { type: ['string', 'null'] },
        mode: { type: 'string', enum: ['x', 'y'] },
      },
      required: ['status'],
      additionalProperties: false,
    })
    assert.deepEqual(out['properties'], {
      status: { type: 'string', enum: ['a', 'b'] },
      note: { type: ['string', 'null'] },
      mode: { type: ['string', 'null'], enum: ['x', 'y', null] },
    })
  })

  it('rewrites OpenAPI nullable to a type array', () => {
    const out = converted({
      type: 'object',
      properties: { a: { type: 'string', nullable: true } },
      required: ['a'],
      additionalProperties: false,
    })
    assert.deepEqual(out['properties'], { a: { type: ['string', 'null'] } })
  })

  it('keeps null in a required object property typed as object or null', () => {
    const out = converted({
      type: 'object',
      properties: {
        x: {
          type: ['object', 'null'],
          properties: { a: { type: 'string' } },
          required: ['a'],
          additionalProperties: false,
        },
      },
      required: ['x'],
      additionalProperties: false,
    })
    const props = out['properties']
    assert.ok(typeof props === 'object' && props !== null && Object.hasOwn(props, 'x'))
    assert.deepEqual(props.x, {
      type: ['object', 'null'],
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    })
  })

  it('rewrites oneOf to anyOf and converts each branch', () => {
    const out = converted({
      type: 'object',
      properties: {
        check: {
          oneOf: [
            {
              type: 'object',
              properties: { kind: { type: 'string', enum: ['shell'] }, cmd: { type: 'string' } },
              required: ['kind'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: { kind: { type: 'string', enum: ['typecheck'] } },
              required: ['kind'],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ['check'],
      additionalProperties: false,
    })
    assert.deepEqual(out['properties'], {
      check: {
        anyOf: [
          {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['shell'] },
              cmd: { type: ['string', 'null'] },
            },
            required: ['kind', 'cmd'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { kind: { type: 'string', enum: ['typecheck'] } },
            required: ['kind'],
            additionalProperties: false,
          },
        ],
      },
    })
  })

  it('makes an optional union nullable by adding a null branch', () => {
    const out = converted({
      type: 'object',
      properties: { u: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
      required: [],
      additionalProperties: false,
    })
    assert.deepEqual(out['properties'], {
      u: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] },
    })
  })

  it('drops constraints strict mode lacks and unsupported formats, keeps supported ones', () => {
    const out = converted({
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 80, default: 'x' },
        url: { type: 'string', format: 'uri' },
        when: { type: 'string', format: 'date-time', pattern: '^2' },
        n: { type: 'integer', minimum: 1, maximum: 9 },
      },
      required: ['title', 'url', 'when', 'n'],
      additionalProperties: false,
    })
    assert.deepEqual(out['properties'], {
      title: { type: 'string' },
      url: { type: 'string' },
      when: { type: 'string', format: 'date-time', pattern: '^2' },
      n: { type: 'integer', minimum: 1, maximum: 9 },
    })
  })

  it('refuses the legacy boolean exclusive bound instead of passing it on', () => {
    const schema = {
      type: 'object',
      properties: { n: { type: 'number', minimum: 0, exclusiveMinimum: true } },
      required: ['n'],
      additionalProperties: false,
    }
    assert.equal(classifyStrictSchema(schema).kind, 'incompatible')
  })

  it('is idempotent: converting the result changes nothing', () => {
    const input = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
      required: ['a'],
      additionalProperties: false,
    }
    assert.equal(strictCompatibleSchema(converted(input)), true)
  })
})

describe('restoreAbsentOptionals', () => {
  const original = {
    type: 'object',
    properties: {
      path: { type: 'string' },
      start_line: { type: 'integer' },
      note: { type: 'string', nullable: true },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, content: { type: 'string' } },
          required: ['content'],
        },
      },
    },
    required: ['path'],
  }

  it('drops a null for an originally optional property', () => {
    assert.deepEqual(restoreAbsentOptionals({ path: 'a', start_line: null }, original), {
      path: 'a',
    })
  })

  it('keeps real values and a null the original schema allows', () => {
    assert.deepEqual(restoreAbsentOptionals({ path: 'a', start_line: 3, note: null }, original), {
      path: 'a',
      start_line: 3,
      note: null,
    })
  })

  it('leaves a null for a required property for the registry to reject', () => {
    assert.deepEqual(restoreAbsentOptionals({ path: null }, original), { path: null })
  })

  it('reaches into arrays of objects', () => {
    assert.deepEqual(
      restoreAbsentOptionals(
        {
          path: 'a',
          items: [
            { id: null, content: 'x' },
            { id: 'k', content: 'y' },
          ],
        },
        original,
      ),
      { path: 'a', items: [{ content: 'x' }, { id: 'k', content: 'y' }] },
    )
  })

  it('passes non-object arguments and unknown keys through', () => {
    assert.equal(restoreAbsentOptionals('oops', original), 'oops')
    assert.deepEqual(restoreAbsentOptionals({ path: 'a', extra: null }, original), {
      path: 'a',
      extra: null,
    })
  })

  it('picks the union branch the value fits', () => {
    const schema = {
      type: 'object',
      properties: {
        check: {
          oneOf: [
            {
              type: 'object',
              properties: { kind: { type: 'string' }, command: { type: 'string' } },
              required: ['kind', 'command'],
            },
            {
              type: 'object',
              properties: {
                kind: { type: 'string' },
                path: { type: 'string' },
                exit: { type: 'number' },
              },
              required: ['kind', 'path'],
            },
          ],
        },
      },
      required: [],
    }
    assert.deepEqual(
      restoreAbsentOptionals({ check: { kind: 'fileExists', path: 'a', exit: null } }, schema),
      { check: { kind: 'fileExists', path: 'a' } },
    )
  })

  it('round-trips: strict conversion then restore yields what the original accepts', () => {
    const strict = converted(original)
    const modelArgs = {
      path: 'a',
      start_line: null,
      note: null,
      items: [{ id: null, content: 'x' }],
    }
    assert.deepEqual(restoreAbsentOptionals(modelArgs, original), {
      path: 'a',
      note: null,
      items: [{ content: 'x' }],
    })
    assert.equal(strictCompatibleSchema(strict), true)
  })

  it('does not let a __proto__ key from JSON pollute the result', () => {
    const args: unknown = JSON.parse('{"path":"a","__proto__":{"polluted":true}}')
    const restored = restoreAbsentOptionals(args, original)
    assert.equal(Object.getPrototypeOf(restored), Object.prototype)
    assert.equal(Reflect.get(Object.prototype, 'polluted'), undefined)
  })
})

describe('prepareStrictTools', () => {
  const qualifying = {
    name: 'read_file',
    description: 'Read',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, start_line: { type: 'integer' } },
      required: ['path'],
      additionalProperties: false,
    },
  }
  const union = {
    name: 'device_hub',
    description: 'Hub',
    parameters: {
      oneOf: [{ type: 'object', properties: {}, required: [], additionalProperties: false }],
    },
  }

  it('marks only convertible tools strict and sends the rest unchanged', () => {
    const set = prepareStrictTools([qualifying, union], true)
    assert.deepEqual(
      set.tools.map((t) => [t.name, t.strict]),
      [
        ['read_file', true],
        ['device_hub', false],
      ],
    )
    assert.deepEqual(set.tools[1]?.parameters, union.parameters)
    assert.deepEqual(set.tools[0]?.parameters['required'], ['path', 'start_line'])
  })

  it('sends everything unchanged and non-strict when disabled', () => {
    const set = prepareStrictTools([qualifying, union], false)
    assert.deepEqual(
      set.tools.map((t) => t.strict),
      [false, false],
    )
    assert.deepEqual(set.tools[0]?.parameters, qualifying.parameters)
    assert.deepEqual(set.restoreArgs('read_file', { path: 'a', start_line: null }), {
      path: 'a',
      start_line: null,
    })
  })

  it('restores arguments only for tools that were sent strict', () => {
    const set = prepareStrictTools([qualifying, union], true)
    assert.deepEqual(set.restoreArgs('read_file', { path: 'a', start_line: null }), { path: 'a' })
    assert.deepEqual(set.restoreArgs('device_hub', { x: null }), { x: null })
  })
})
