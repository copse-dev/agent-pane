import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PNG } from 'pngjs'
import { classifyScreenshotChange, type ClassifyOptions } from './filter-screenshots.mts'

const OPTS: ClassifyOptions = { colorThreshold: 0.1, ignoreRatio: 0.0008, ignoreMinPixels: 12 }

/** A solid-colour PNG encoded to PNG bytes. */
function solid(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const png = new PNG({ width, height })
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = r
    png.data[i * 4 + 1] = g
    png.data[i * 4 + 2] = b
    png.data[i * 4 + 3] = 255
  }
  return PNG.sync.write(png)
}

/** `base` with `count` isolated pixels flipped to black — a small, non-AA diff. */
function withFlippedPixels(
  width: number,
  height: number,
  base: [number, number, number],
  count: number,
): Buffer {
  const png = PNG.sync.read(solid(width, height, base))
  for (let i = 0; i < count; i++) {
    // Spread the flipped pixels out so pixelmatch's AA detector doesn't fold them.
    const p = i * 37 * 4
    png.data[p] = 0
    png.data[p + 1] = 0
    png.data[p + 2] = 0
    png.data[p + 3] = 255
  }
  return PNG.sync.write(png)
}

const WHITE: [number, number, number] = [255, 255, 255]
const RED: [number, number, number] = [255, 0, 0]
const BLUE: [number, number, number] = [0, 0, 255]
const GREEN: [number, number, number] = [0, 255, 0]

describe('classifyScreenshotChange', () => {
  it('keeps a brand-new screenshot with no baseline', () => {
    const v = classifyScreenshotChange(null, solid(100, 100, RED), [], OPTS)
    assert.equal(v.decision, 'keep')
  })

  it('ignores an identical re-render as noise', () => {
    const base = solid(100, 100, WHITE)
    const v = classifyScreenshotChange(base, solid(100, 100, WHITE), [], OPTS)
    assert.equal(v.decision, 'ignore')
  })

  it('ignores a handful of stray pixels below the threshold', () => {
    const base = solid(100, 100, WHITE)
    const v = classifyScreenshotChange(base, withFlippedPixels(100, 100, WHITE, 5), [], OPTS)
    assert.equal(v.decision, 'ignore')
  })

  it('keeps a clearly different re-render when there are no prior renders', () => {
    const v = classifyScreenshotChange(solid(100, 100, WHITE), solid(100, 100, RED), [], OPTS)
    assert.equal(v.decision, 'keep')
    assert.equal(v.reason, 'real visual change')
  })

  it('flags a real change that matches a recent committed render as flapping', () => {
    // HEAD is BLUE, the new render is RED, and RED was committed earlier (a prior
    // render). Committing RED again just brings BLUE back next run — a flap.
    const head = solid(100, 100, BLUE)
    const rerender = solid(100, 100, RED)
    const priorRed = solid(100, 100, RED)
    const v = classifyScreenshotChange(head, rerender, [priorRed], OPTS)
    assert.equal(v.decision, 'flap')
  })

  it('tolerates sub-threshold wobble when matching a prior render', () => {
    // The new render differs from a prior committed render by only a few pixels
    // (runner noise) — still recognised as the same flapping state.
    const head = solid(100, 100, BLUE)
    const rerender = withFlippedPixels(100, 100, RED, 4)
    const priorRed = solid(100, 100, RED)
    const v = classifyScreenshotChange(head, rerender, [priorRed], OPTS)
    assert.equal(v.decision, 'flap')
  })

  it('keeps a real change when no prior render matches', () => {
    const head = solid(100, 100, WHITE)
    const rerender = solid(100, 100, RED)
    const priors = [solid(100, 100, BLUE), solid(100, 100, GREEN)]
    const v = classifyScreenshotChange(head, rerender, priors, OPTS)
    assert.equal(v.decision, 'keep')
  })

  it('disables flap detection when the prior list is empty', () => {
    const head = solid(100, 100, BLUE)
    const rerender = solid(100, 100, RED)
    const v = classifyScreenshotChange(head, rerender, [], OPTS)
    assert.equal(v.decision, 'keep')
  })

  it('keeps a re-render whose dimensions changed', () => {
    const v = classifyScreenshotChange(solid(100, 100, WHITE), solid(120, 100, WHITE), [], OPTS)
    assert.equal(v.decision, 'keep')
    assert.equal(v.reason, 'dimensions changed')
  })
})
