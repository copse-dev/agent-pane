import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_DIAGRAM_DIMENSION,
  MAX_DIAGRAM_SOURCE_LENGTH,
  parseDiagramSize,
  parseDiagramSource,
} from './mermaid-frame-protocol.ts'

describe('untrusted diagram frame protocol', () => {
  it('accepts source as data and rejects oversized or differently shaped requests', () => {
    const source = '</script><svg onload="alert(1)">'
    assert.equal(parseDiagramSource({ type: 'render', source }), source)
    assert.equal(
      parseDiagramSource({ type: 'render', source: 'x'.repeat(MAX_DIAGRAM_SOURCE_LENGTH + 1) }),
      null,
    )
    for (const value of [
      null,
      source,
      { type: 'render', source: 12 },
      { type: 'execute', source },
    ]) {
      assert.equal(parseDiagramSource(value), null)
    }
  })

  it('rejects non-finite, negative, or non-numeric sizes and ignores capabilities', () => {
    for (const value of [
      null,
      {},
      { type: 'open-url', url: 'https://example.com' },
      { type: 'rendered', width: NaN, height: 10 },
      { type: 'rendered', width: 10, height: Infinity },
      { type: 'rendered', width: -1, height: 10 },
      { type: 'rendered', width: '10', height: 10 },
    ]) {
      assert.equal(parseDiagramSize(value), null)
    }
    assert.deepEqual(
      parseDiagramSize({
        type: 'rendered',
        width: 1e9,
        height: 2.5,
        html: '<img onerror=alert(1)>',
      }),
      { width: MAX_DIAGRAM_DIMENSION, height: 2.5 },
    )
  })
})
