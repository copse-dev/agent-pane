import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseToolArgs } from './parse-tool-args.ts'

describe('parseToolArgs', () => {
  it('parses valid JSON arguments', () => {
    const result = parseToolArgs('{"path":"a.ts","line":3}')
    assert.deepEqual(result.args, { path: 'a.ts', line: 3 })
    assert.equal(result.error, undefined)
  })

  it('treats empty/whitespace as a valid no-arg call', () => {
    assert.deepEqual(parseToolArgs('').args, {})
    assert.deepEqual(parseToolArgs('   ').args, {})
    assert.deepEqual(parseToolArgs(undefined).args, {})
    assert.deepEqual(parseToolArgs(null).args, {})
    assert.equal(parseToolArgs('').error, undefined)
  })

  it('reports an error (not silent empty args) for malformed JSON', () => {
    const result = parseToolArgs('{"path":"a.ts"')
    assert.deepEqual(result.args, {})
    assert.ok(result.error, 'expected an error message')
    assert.match(result.error!, /Could not parse tool arguments/)
    assert.match(result.error!, /\{"path":"a\.ts"/)
  })

  it('truncates very large raw payloads in the error', () => {
    const big = `{"x":"${'a'.repeat(2000)}`
    const result = parseToolArgs(big)
    assert.ok(result.error)
    assert.ok(result.error!.length < big.length)
    assert.match(result.error!, /…/)
  })
})
