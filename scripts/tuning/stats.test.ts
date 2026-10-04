import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  mean,
  pairedBootstrap,
  quantileSorted,
  sampleVariance,
  seededRandom,
  wilsonInterval,
} from './stats.mts'

function near(actual: number, expected: number, tolerance = 5e-4): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${String(actual)} is not within ${String(tolerance)} of ${String(expected)}`,
  )
}

describe('wilsonInterval', () => {
  it('matches hand-computed 95% intervals', () => {
    // 8/10: centre (0.8 + z^2/20) / (1 + z^2/10) = 0.71671, half-width 0.22658.
    const eight = wilsonInterval(8, 10)
    near(eight.lo, 0.4902)
    near(eight.hi, 0.9433)
    // 5/10 is symmetric about one half.
    const five = wilsonInterval(5, 10)
    near(five.lo, 0.2366)
    near(five.hi, 0.7634)
  })

  it('does not collapse at the extremes', () => {
    // 0/10: the upper bound is z^2 / (n + z^2) = 0.2775.
    const none = wilsonInterval(0, 10)
    assert.equal(none.lo, 0)
    near(none.hi, 0.2775)
    const all = wilsonInterval(10, 10)
    near(all.lo, 0.7225)
    assert.ok(all.hi <= 1)
  })

  it('is uninformative with no trials', () => {
    assert.deepEqual(wilsonInterval(0, 0), { lo: 0, hi: 1 })
  })
})

describe('seededRandom', () => {
  it('is deterministic and matches the reference mulberry32 stream for seed 42', () => {
    const first = seededRandom(42)
    const second = seededRandom(42)
    const values = [first(), first(), first()]
    assert.deepEqual([second(), second(), second()], values)
    near(values[0] ?? 0, 0.6011037519201636, 1e-12)
    near(values[1] ?? 0, 0.44829055899754167, 1e-12)
    near(values[2] ?? 0, 0.8524657934904099, 1e-12)
  })

  it('differs across seeds and stays in [0, 1)', () => {
    const a = seededRandom(1)
    const b = seededRandom(2)
    assert.notEqual(a(), b())
    const c = seededRandom(3)
    for (let index = 0; index < 1000; index += 1) {
      const value = c()
      assert.ok(value >= 0 && value < 1)
    }
  })
})

describe('summary helpers', () => {
  it('computes mean, unbiased variance and interpolated quantiles', () => {
    assert.equal(mean([1, 2, 3, 4]), 2.5)
    near(sampleVariance([1, 0, 1, 0]), 1 / 3)
    assert.equal(sampleVariance([1]), 0)
    assert.equal(quantileSorted([0, 10], 0.25), 2.5)
    assert.equal(quantileSorted([1, 2, 3], 0.5), 2)
  })
})

describe('pairedBootstrap', () => {
  const candidate = new Map([
    ['a', [1, 1]],
    ['b', [0, 0]],
  ])
  const baseline = new Map([
    ['a', [0, 0]],
    ['b', [0, 0]],
  ])

  it('is exactly reproducible for a seed', () => {
    const one = pairedBootstrap(candidate, baseline, { iterations: 500, seed: 9 })
    const two = pairedBootstrap(candidate, baseline, { iterations: 500, seed: 9 })
    assert.deepEqual(one, two)
  })

  it('reports the observed task-level difference and the hand-computed interval', () => {
    // Task differences are +1 and 0 with no rep noise. A bootstrap mean over two tasks
    // is 0, 0.5 or 1 with probability 1/4, 1/2, 1/4, so the 2.5% and 97.5% quantiles
    // are 0 and 1.
    const result = pairedBootstrap(candidate, baseline, { iterations: 4000, seed: 3 })
    assert.equal(result.diff, 0.5)
    assert.equal(result.tasks, 2)
    assert.equal(result.lo, 0)
    assert.equal(result.hi, 1)
  })

  it('collapses to a point when every task differs by the same amount', () => {
    const wins = new Map([
      ['a', [1, 1]],
      ['b', [1, 1]],
      ['c', [1, 1]],
    ])
    const losses = new Map([
      ['a', [0, 0]],
      ['b', [0, 0]],
      ['c', [0, 0]],
    ])
    const result = pairedBootstrap(wins, losses, { iterations: 1000, seed: 1 })
    assert.deepEqual([result.diff, result.lo, result.hi], [1, 1, 1])
  })

  it('widens with within-task rep noise: resampled reps carry run-to-run flips', () => {
    // One task, reps 1 0 versus 0 0: the observed difference is 0.5, but resampling the
    // candidate's two reps gives 0, 0.5 or 1 (hence a difference of 0 to 1).
    const result = pairedBootstrap(new Map([['a', [1, 0]]]), new Map([['a', [0, 0]]]), {
      iterations: 4000,
      seed: 5,
    })
    assert.equal(result.diff, 0.5)
    assert.equal(result.lo, 0)
    assert.equal(result.hi, 1)
  })

  it('only pairs tasks present in both configs', () => {
    const result = pairedBootstrap(
      new Map([
        ['a', [1]],
        ['only-candidate', [1]],
      ]),
      new Map([
        ['a', [0]],
        ['only-baseline', [0]],
      ]),
      { iterations: 50, seed: 1 },
    )
    assert.equal(result.tasks, 1)
  })

  it('returns NaN when nothing pairs', () => {
    const result = pairedBootstrap(new Map([['a', [1]]]), new Map([['b', [1]]]))
    assert.equal(result.tasks, 0)
    assert.ok(Number.isNaN(result.diff))
  })
})
