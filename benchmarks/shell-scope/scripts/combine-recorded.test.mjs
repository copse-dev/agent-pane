import assert from 'node:assert/strict'
import test from 'node:test'
import { combine, replayCombinations } from './combine-recorded.mjs'
import { replayCascades } from './cascade-thresholds.mjs'

test('offline combinations preserve the recorded errors, abstentions, and development-only fitting', async () => {
  const replay = await replayCombinations()
  assert.equal(replay.assertions, 26)
  for (const [candidate, correct, wrongSandbox, wrongExternal] of [
    ['laya', 87, 3, 10],
    ['laya-base', 87, 3, 10],
    ['openjev', 84, 3, 13],
    ['semif', 58, 0, 42],
    ['kev', 29, 0, 71],
  ]) {
    const row = replay.combinations.find(
      (entry) =>
        entry.candidate === candidate && entry.split === 'holdout' && entry.mode === 'raw-veto',
    )
    assert.ok(row)
    assert.deepEqual(
      [row.correct, row.wrongSandbox, row.wrongExternal],
      [correct, wrongSandbox, wrongExternal],
    )
  }
  const majority = replay.combinations.find(
    (row) => row.mode === 'majority' && row.split === 'holdout',
  )
  assert.deepEqual([majority.correct, majority.wrongSandbox, majority.wrongExternal], [80, 9, 11])
  const claude = replay.combinations.find(
    (row) => row.candidate === 'acp' && row.mode === 'raw-veto',
  )
  assert.deepEqual(
    [claude.split, claude.correct, claude.wrongSandbox, claude.wrongExternal],
    ['dev', 92, 0, 8],
  )
  assert.equal(
    replay.combinations.some((row) => row.candidate === 'acp' && row.split === 'holdout'),
    false,
  )
  for (const row of replay.combinations) {
    assert.equal(row.correct + row.wrongSandbox + row.wrongExternal + row.abstained, row.planned)
  }
  assert.equal(combine('ambiguous', null, 'confidence-replace', false), 'external')
  assert.equal(combine('sandbox', null, 'agreement-abstain', false), null)
  const cascades = await replayCascades(replay)
  for (const row of cascades.rows.filter((entry) => entry.split === 'holdout')) {
    assert.deepEqual([row.correct, row.wrongSandbox, row.wrongExternal], [87, 3, 10])
    assert.equal(row.policy.veto.threshold, null)
    assert.equal(row.policy.override.threshold, null)
  }
  const altered = structuredClone(replay)
  for (const group of altered.observations.filter((entry) => entry.split === 'holdout')) {
    for (const row of group.rows) row.label = row.label === 'sandbox' ? 'external' : 'sandbox'
  }
  const changedHoldout = await replayCascades(altered)
  assert.deepEqual(
    changedHoldout.rows.map((row) => row.policy),
    cascades.rows.map((row) => row.policy),
    'Holdout labels must never affect threshold fitting',
  )
})
