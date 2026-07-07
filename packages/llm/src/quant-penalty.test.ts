import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { estimateQuantPenalty, estimateQuantizedScore } from './quant-penalty.ts'

describe('quant penalty estimator', () => {
  it('is near-lossless at 8 bpw and grows as bits drop', () => {
    const p8 = estimateQuantPenalty({ bitsPerWeight: 8, paramsB: 30 })
    const p4 = estimateQuantPenalty({ bitsPerWeight: 4.5, paramsB: 30 })
    const p2 = estimateQuantPenalty({ bitsPerWeight: 2.6, paramsB: 30 })
    assert.ok(p8 < 0.005, `8bpw should be near-lossless, got ${String(p8)}`)
    assert.ok(p4 > p8 && p4 < 0.03, `4.5bpw@30B should be ~1-2%, got ${String(p4)}`)
    assert.ok(p2 > p4 && p2 > 0.1, `2.6bpw@30B should be sizeable, got ${String(p2)}`)
  })

  it('penalizes smaller models more than larger ones at the same bit width', () => {
    const big = estimateQuantPenalty({ bitsPerWeight: 4.5, paramsB: 70 })
    const mid = estimateQuantPenalty({ bitsPerWeight: 4.5, paramsB: 13 })
    const small = estimateQuantPenalty({ bitsPerWeight: 4.5, paramsB: 3 })
    assert.ok(
      small > mid && mid > big,
      `expected small>mid>big, got ${String(small)}, ${String(mid)}, ${String(big)}`,
    )
  })

  it('never exceeds the 0.6 cap even for extreme quant', () => {
    assert.ok(estimateQuantPenalty({ bitsPerWeight: 1, paramsB: 1 }) <= 0.6)
  })

  it('applies a task-sensitivity multiplier when given', () => {
    const neutral = estimateQuantPenalty({ bitsPerWeight: 4.5, paramsB: 13 })
    const code = estimateQuantPenalty({ bitsPerWeight: 4.5, paramsB: 13, taskSensitivity: 1.3 })
    assert.ok(code > neutral)
  })

  it('estimates a quantized score below the full score and flags it', () => {
    const est = estimateQuantizedScore(80, { bitsPerWeight: 4.5, paramsB: 32 })
    assert.equal(est.estimated, true)
    assert.ok(
      est.value < 80 && est.value > 70,
      `expected a small drop from 80, got ${String(est.value)}`,
    )
    assert.match(est.basis, /quant penalty/)
  })

  it('clamps the estimate to [0, fullScore]', () => {
    const zero = estimateQuantizedScore(0, { bitsPerWeight: 2, paramsB: 1 })
    assert.equal(zero.value, 0)
    const tiny = estimateQuantizedScore(10, { bitsPerWeight: 2, paramsB: 1 })
    assert.ok(tiny.value >= 0 && tiny.value <= 10)
  })
})
