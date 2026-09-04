import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  coolingDownSafetyModels,
  isSafetyModelCoolingDown,
  isScreeningTimeout,
  noteSafetyModelAnswered,
  noteSafetyModelTimeout,
  resetSafetyModelCooldownsForTest,
  safetyModelCoolingDownProblem,
  SAFETY_MODEL_COOLDOWN_MS,
  setSafetyModelClockForTest,
} from './safety-model-cooldown.ts'

/**
 * A safety model that clears the intelligence bar can still be too slow to be
 * worth calling: `google/gemma-4-12b` scores 22.2 and takes ~13.6s on a full
 * 6000-character snapshot, so it missed the 8s budget every time. These tests
 * pin the two halves of that judgement — noticing it, and not over-reacting to
 * a cold start — plus the fact that it always expires.
 */

const MODEL = 'lmstudio:google/gemma-4-12b'
const OTHER = 'lmstudio:qwen/qwen3-4b-2507'
const BUDGET = 8_000
const MINUTE = 60_000

let now = 1_700_000_000_000

beforeEach(() => {
  now = 1_700_000_000_000
  setSafetyModelClockForTest(() => now)
  resetSafetyModelCooldownsForTest()
})

afterEach(() => {
  setSafetyModelClockForTest(null)
  resetSafetyModelCooldownsForTest()
})

describe('isScreeningTimeout', () => {
  it('recognises the abort the screening budget raises', () => {
    assert.equal(
      isScreeningTimeout(new DOMException('This operation was aborted', 'AbortError')),
      true,
    )
    const named = new Error('timed out')
    named.name = 'TimeoutError'
    assert.equal(isScreeningTimeout(named), true)
  })

  it('does not blame the model for the user cancelling the turn', () => {
    // `completeMessagesWithUsage` aborts one controller from two places, so the
    // throw looks identical either way. The caller's signal is the only thing
    // that separates them, and a cancelled turn says nothing about speed.
    const controller = new AbortController()
    controller.abort()
    assert.equal(
      isScreeningTimeout(new DOMException('Aborted', 'AbortError'), controller.signal),
      false,
    )
  })

  it('does not count an ordinary screening failure', () => {
    assert.equal(isScreeningTimeout(new Error('404 Model not found')), false)
    assert.equal(isScreeningTimeout(new Error('fetch failed')), false)
    assert.equal(isScreeningTimeout(null), false)
    assert.equal(isScreeningTimeout('AbortError'), false)
  })
})

describe('noteSafetyModelTimeout', () => {
  it('does not condemn a model on one timeout — that is what a cold start looks like', () => {
    const problem = noteSafetyModelTimeout(MODEL, BUDGET)
    assert.equal(problem.reason, 'timed-out')
    assert.equal(problem.model, MODEL)
    // The message names the model and the budget it missed; "could not screen
    // it" is what made this indistinguishable from every other failure.
    assert.match(problem.message, /google\/gemma-4-12b/)
    assert.match(problem.message, /8s/)
    assert.equal(isSafetyModelCoolingDown(MODEL), false)
  })

  it('stops routing to a model that misses the budget twice', () => {
    noteSafetyModelTimeout(MODEL, BUDGET)
    now += 20_000
    const problem = noteSafetyModelTimeout(MODEL, BUDGET)

    assert.equal(isSafetyModelCoolingDown(MODEL), true)
    assert.deepEqual(coolingDownSafetyModels(), [MODEL])
    assert.match(problem.message, /skipping it/)
    assert.match(problem.message, /10 minutes/)
  })

  it('keeps each model tally separate', () => {
    noteSafetyModelTimeout(MODEL, BUDGET)
    noteSafetyModelTimeout(OTHER, BUDGET)
    noteSafetyModelTimeout(MODEL, BUDGET)

    assert.equal(isSafetyModelCoolingDown(MODEL), true)
    assert.equal(isSafetyModelCoolingDown(OTHER), false)
    assert.deepEqual(coolingDownSafetyModels(), [MODEL])
  })

  it('treats two timeouts far apart as two cold starts, not a slow model', () => {
    // Servers evict idle models, so a timeout after a long quiet spell may well
    // be another just-in-time load rather than evidence of anything.
    noteSafetyModelTimeout(MODEL, BUDGET)
    now += 6 * MINUTE
    noteSafetyModelTimeout(MODEL, BUDGET)
    assert.equal(isSafetyModelCoolingDown(MODEL), false)

    // Counting restarts rather than resetting to zero: the second timeout is
    // still a first strike, so one more inside the window settles it.
    now += 30_000
    noteSafetyModelTimeout(MODEL, BUDGET)
    assert.equal(isSafetyModelCoolingDown(MODEL), true)
  })

  it('forgets the strikes once the model answers in time', () => {
    noteSafetyModelTimeout(MODEL, BUDGET)
    noteSafetyModelAnswered(MODEL)
    now += 1_000
    noteSafetyModelTimeout(MODEL, BUDGET)
    assert.equal(isSafetyModelCoolingDown(MODEL), false)
  })
})

describe('the cooldown expiring', () => {
  it('lets a model that was slow for a passing reason recover on its own', () => {
    noteSafetyModelTimeout(MODEL, BUDGET)
    noteSafetyModelTimeout(MODEL, BUDGET)
    assert.equal(isSafetyModelCoolingDown(MODEL), true)

    now += SAFETY_MODEL_COOLDOWN_MS - 1
    assert.equal(isSafetyModelCoolingDown(MODEL), true)

    now += 2
    assert.equal(isSafetyModelCoolingDown(MODEL), false)
    assert.deepEqual(coolingDownSafetyModels(), [])
  })

  it('gives the recovered model a clean slate rather than a hair trigger', () => {
    noteSafetyModelTimeout(MODEL, BUDGET)
    noteSafetyModelTimeout(MODEL, BUDGET)
    now += SAFETY_MODEL_COOLDOWN_MS + 1

    // One timeout after recovery is one timeout, not a third strike: without
    // this a model would be skipped for ever in ten-minute instalments.
    noteSafetyModelTimeout(MODEL, BUDGET)
    assert.equal(isSafetyModelCoolingDown(MODEL), false)
  })
})

describe('safetyModelCoolingDownProblem', () => {
  it('says screening is unavailable rather than pretending it happened', () => {
    const problem = safetyModelCoolingDownProblem(MODEL, BUDGET)
    assert.equal(problem.reason, 'timed-out')
    assert.equal(problem.model, MODEL)
    assert.match(problem.message, /no other model is available/)
  })
})
