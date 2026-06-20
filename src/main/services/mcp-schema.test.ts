import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeMcpInputSchema, flattenMcpContent } from './mcp-schema.ts'

describe('sanitizeMcpInputSchema', () => {
  it('passes through a valid object schema', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    }
    const out = sanitizeMcpInputSchema(schema)
    assert.equal(out.type, 'object')
    assert.deepEqual(out.properties, { name: { type: 'string' } })
    assert.deepEqual(out.required, ['name'])
  })

  it('defaults missing/invalid schema to an empty object schema', () => {
    assert.deepEqual(sanitizeMcpInputSchema(undefined), { type: 'object', properties: {} })
    assert.deepEqual(sanitizeMcpInputSchema(null), { type: 'object', properties: {} })
    assert.deepEqual(sanitizeMcpInputSchema('nope'), { type: 'object', properties: {} })
  })

  it('forces type:object and ensures properties exists', () => {
    const out = sanitizeMcpInputSchema({ type: 'array' })
    assert.equal(out.type, 'object')
    assert.deepEqual(out.properties, {})
  })
})

describe('flattenMcpContent', () => {
  it('joins text blocks with newlines', () => {
    const out = flattenMcpContent([
      { type: 'text', text: 'line 1' },
      { type: 'text', text: 'line 2' },
    ])
    assert.equal(out, 'line 1\nline 2')
  })

  it('summarizes images and resource links', () => {
    const out = flattenMcpContent([
      { type: 'image', mimeType: 'image/png' },
      { type: 'resource_link', uri: 'file:///x' },
    ])
    assert.match(out, /\[image image\/png omitted\]/)
    assert.match(out, /\[resource link: file:\/\/\/x\]/)
  })

  it('reads embedded resource text', () => {
    const out = flattenMcpContent([
      { type: 'resource', resource: { uri: 'file:///a', text: 'hello' } },
    ])
    assert.equal(out, 'hello')
  })

  it('returns a string input unchanged and empty for unknown', () => {
    assert.equal(flattenMcpContent('raw'), 'raw')
    assert.equal(flattenMcpContent(undefined), '')
  })
})
