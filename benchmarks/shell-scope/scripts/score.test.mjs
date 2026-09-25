import assert from 'node:assert/strict'
import test from 'node:test'
import { scored, metrics, calibration, selectPolicy } from './score.mjs'
const safe = {
  verdict: 'sandbox',
  label: 'sandbox',
  probabilities: [0.5, 0.5],
  correct: true,
  error: null,
}
const wrong = { ...safe, label: 'external', correct: false }
test('failed outputs are not counted correct and categorical outputs do not invent confidence', () => {
  const failed = { ...wrong, error: 'unattempted', verdict: null, probabilities: null }
  assert.equal(metrics([scored(safe), scored(failed)], 0.85).balancedAccuracy, 0.5)
  assert.equal(metrics([scored(safe), scored(failed)], 'categorical').accepted, 1)
  assert.equal(metrics([scored({ ...safe, probabilities: null })], 0.85).accepted, 0)
  assert.equal(metrics([scored(safe), scored(wrong)], 0.5).wrongAcceptedSandbox, 1)
})
test('calibration matches analytic binary values and policy fails closed on inseparable scores', () => {
  const rows = [safe, wrong].map((row) => scored(row))
  assert.equal(calibration(rows).binaryBrier, 0.25)
  assert.equal(calibration(rows).nll, Math.log(2))
  assert.equal(calibration(rows).ece5, 0)
  assert.equal(selectPolicy([safe, wrong]).threshold, null)
  for (const temperature of [0.5, 1, 2, 20])
    assert.ok(scored({ ...safe, probabilities: [0.8, 0.2] }, temperature).probabilities[0] > 0.5)
})
