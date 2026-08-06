import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { synthesizeToolCallId, toolCallIdOrSynthesized } from './tool-call-id.ts'

describe('synthesizeToolCallId', () => {
  it('produces a fresh prefixed id on every call', () => {
    const ids = Array.from({ length: 100 }, () => synthesizeToolCallId())
    for (const id of ids) assert.match(id, /^tc_/)
    assert.equal(new Set(ids).size, ids.length, 'synthesized ids must be unique')
  })
})

describe('toolCallIdOrSynthesized', () => {
  it('keeps an id the provider supplied', () => {
    assert.equal(toolCallIdOrSynthesized('call_abc'), 'call_abc')
  })

  it('synthesizes for missing, empty, and whitespace-only ids', () => {
    for (const absent of [undefined, null, '', '   ', '\t\n']) {
      assert.match(toolCallIdOrSynthesized(absent), /^tc_/)
    }
  })

  it('does not reuse one synthesized id across calls', () => {
    assert.notEqual(toolCallIdOrSynthesized(''), toolCallIdOrSynthesized(''))
  })

  it('preserves an id that merely looks synthesized', () => {
    // A provider is free to send its own `tc_`-prefixed id; it must survive.
    assert.equal(toolCallIdOrSynthesized('tc_from_provider'), 'tc_from_provider')
  })
})
