import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseClassification } from './safety-classification-parse.ts'

// `parseClassification` is the trust boundary between the local safety model's
// freeform text and the permission gate (see `decideShellPermission`). A verdict
// it returns can auto-run a command without prompting, so every rejection and the
// confidence clamp below is load-bearing.
describe('parseClassification', () => {
  it('parses a well-formed sandbox verdict', () => {
    const result = parseClassification(
      '{"scope":"sandbox","confidence":0.9,"reason":"reads a file in the workspace"}',
    )
    assert.deepEqual(result, {
      scope: 'sandbox',
      confidence: 0.9,
      reason: 'reads a file in the workspace',
    })
  })

  it('parses a well-formed external verdict', () => {
    const result = parseClassification(
      '{"scope":"external","confidence":0.4,"reason":"curls a remote host"}',
    )
    assert.deepEqual(result, {
      scope: 'external',
      confidence: 0.4,
      reason: 'curls a remote host',
    })
  })

  it('extracts the JSON object from surrounding prose or markdown fences', () => {
    const result = parseClassification(
      'Sure! Here is my answer:\n```json\n{"scope":"external","confidence":0.5,"reason":"network"}\n```\nHope that helps.',
    )
    assert.deepEqual(result, { scope: 'external', confidence: 0.5, reason: 'network' })
  })

  it('returns null when there is no JSON object at all', () => {
    assert.equal(parseClassification('I cannot help with that.'), null)
    assert.equal(parseClassification(''), null)
  })

  it('returns null on malformed JSON', () => {
    assert.equal(parseClassification('{"scope":"sandbox", confidence: 0.9,}'), null)
  })

  it('rejects an unknown scope rather than trusting it', () => {
    assert.equal(parseClassification('{"scope":"maybe","confidence":0.9,"reason":"unsure"}'), null)
    assert.equal(
      parseClassification('{"scope":"SANDBOX","confidence":0.9,"reason":"case matters"}'),
      null,
    )
    assert.equal(parseClassification('{"confidence":0.9,"reason":"no scope"}'), null)
  })

  it('rejects a verdict with no reason so the gate never auto-runs on empty justification', () => {
    assert.equal(parseClassification('{"scope":"sandbox","confidence":1,"reason":""}'), null)
    assert.equal(parseClassification('{"scope":"sandbox","confidence":1,"reason":"   "}'), null)
    assert.equal(parseClassification('{"scope":"sandbox","confidence":1}'), null)
  })

  it('trims surrounding whitespace from the reason', () => {
    const result = parseClassification(
      '{"scope":"sandbox","confidence":0.8,"reason":"  local build  "}',
    )
    assert.equal(result?.reason, 'local build')
  })

  it('clamps an out-of-range confidence into [0, 1]', () => {
    assert.equal(
      parseClassification('{"scope":"sandbox","confidence":5,"reason":"over"}')?.confidence,
      1,
    )
    assert.equal(
      parseClassification('{"scope":"sandbox","confidence":-3,"reason":"under"}')?.confidence,
      0,
    )
  })

  it('treats a missing or non-finite confidence as zero (least-trusted)', () => {
    assert.equal(parseClassification('{"scope":"sandbox","reason":"no confidence"}')?.confidence, 0)
    assert.equal(
      parseClassification('{"scope":"sandbox","confidence":"high","reason":"string"}')?.confidence,
      0,
    )
    assert.equal(
      parseClassification('{"scope":"sandbox","confidence":null,"reason":"null"}')?.confidence,
      0,
    )
  })
})
