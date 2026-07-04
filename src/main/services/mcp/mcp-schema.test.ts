import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeMcpInputSchema, flattenMcpContent, extractUiResources } from './mcp-schema.ts'

describe('sanitizeMcpInputSchema', () => {
  it('passes through a valid object schema', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    }
    const out = sanitizeMcpInputSchema(schema)
    assert.equal(out['type'], 'object')
    assert.deepEqual(out['properties'], { name: { type: 'string' } })
    assert.deepEqual(out['required'], ['name'])
  })

  it('defaults missing/invalid schema to an empty object schema', () => {
    assert.deepEqual(sanitizeMcpInputSchema(undefined), { type: 'object', properties: {} })
    assert.deepEqual(sanitizeMcpInputSchema(null), { type: 'object', properties: {} })
    assert.deepEqual(sanitizeMcpInputSchema('nope'), { type: 'object', properties: {} })
  })

  it('forces type:object and ensures properties exists', () => {
    const out = sanitizeMcpInputSchema({ type: 'array' })
    assert.equal(out['type'], 'object')
    assert.deepEqual(out['properties'], {})
  })

  it('strips $ref / $defs and other reference keywords (#107)', () => {
    const out = sanitizeMcpInputSchema({
      type: 'object',
      $defs: { Node: { $ref: '#/$defs/Node' } },
      properties: { child: { $ref: '#/$defs/Node' } },
    })
    assert.equal(out['$defs'], undefined)
    assert.deepEqual(out['properties'], { child: {} })
  })

  it('caps oversized enum arrays (#107)', () => {
    const big = Array.from({ length: 500 }, (_, i) => i)
    const out = sanitizeMcpInputSchema({
      type: 'object',
      properties: { k: { type: 'number', enum: big } },
    })
    const props = out['properties'] as Record<string, { enum: number[] }>
    assert.equal(props['k']?.enum.length, 100)
  })

  it('truncates deeply nested schemas without throwing (#107)', () => {
    let node: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 30; i++) node = { type: 'object', properties: { next: node } }
    const out = sanitizeMcpInputSchema(node)
    assert.equal(out['type'], 'object')
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

  it('inlines UI resource bodies by default (legacy shape)', () => {
    const out = flattenMcpContent([
      { type: 'resource', resource: { uri: 'ui://x', mimeType: 'text/html', text: '<h1>hi</h1>' } },
    ])
    assert.equal(out, '<h1>hi</h1>')
  })

  it('summarizes UI resources when asked, keeping the body out of the transcript', () => {
    const out = flattenMcpContent(
      [
        { type: 'text', text: 'before' },
        {
          type: 'resource',
          resource: { uri: 'ui://component/dashboard', mimeType: 'text/html', text: '<h1>hi</h1>' },
        },
      ],
      { summarizeUiResources: true },
    )
    assert.match(out, /before/)
    assert.match(
      out,
      /\[ui resource: ui:\/\/component\/dashboard \(text\/html, [\d.]+ KB\) — rendered in the canvas\]/,
    )
    assert.doesNotMatch(out, /<h1>/)
  })

  it('leaves non-UI resources untouched when summarizing', () => {
    const out = flattenMcpContent(
      [{ type: 'resource', resource: { uri: 'file:///a', mimeType: 'text/plain', text: 'plain' } }],
      { summarizeUiResources: true },
    )
    assert.equal(out, 'plain')
  })
})

describe('extractUiResources', () => {
  it('extracts text/html and text/uri-list resources', () => {
    const out = extractUiResources([
      { type: 'text', text: 'noise' },
      { type: 'resource', resource: { uri: 'ui://a', mimeType: 'text/html', text: '<p>a</p>' } },
      {
        type: 'resource',
        resource: { uri: 'ui://b', mimeType: 'text/uri-list', text: 'https://example.com' },
      },
    ])
    assert.deepEqual(out, [
      { uri: 'ui://a', mimeType: 'text/html', text: '<p>a</p>' },
      { uri: 'ui://b', mimeType: 'text/uri-list', text: 'https://example.com' },
    ])
  })

  it('ignores non-UI mime types, empty bodies, and oversized payloads', () => {
    const huge = 'x'.repeat(600 * 1024)
    const out = extractUiResources([
      { type: 'resource', resource: { uri: 'file:///a', mimeType: 'text/plain', text: 'plain' } },
      { type: 'resource', resource: { uri: 'ui://empty', mimeType: 'text/html', text: '' } },
      { type: 'resource', resource: { uri: 'ui://big', mimeType: 'text/html', text: huge } },
    ])
    assert.deepEqual(out, [])
  })

  it('returns [] for non-array content', () => {
    assert.deepEqual(extractUiResources('raw'), [])
    assert.deepEqual(extractUiResources(undefined), [])
  })
})
