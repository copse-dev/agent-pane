import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const policyProbe = `
import json
from benchmarks.skillsbench.trial_policy import classify_trial
print(json.dumps([
    classify_trial(982, 2),
    classify_trial(1000, 1),
    classify_trial(2000, 0),
]))
`

describe('SkillsBench minimum-work policy', () => {
  it('voids the observed degenerate trial at the predeclared boundary', () => {
    const probe = spawnSync('python3', ['-c', policyProbe], { encoding: 'utf8' })
    assert.equal(probe.status, 0, probe.stderr)
    const classifications: unknown = JSON.parse(probe.stdout)
    assert.deepEqual(classifications, [
      { status: 'void', reason: 'input tokens 982 < 1000' },
      { status: 'scored', reason: null },
      { status: 'void', reason: 'tool calls 0 < 1' },
    ])
  })

  it('carries void status into both capsules and the fetched-run summary', () => {
    const runner = readFileSync('benchmarks/skillsbench/run_spike.py', 'utf8')
    assert.match(runner, /"trialPolicy": MINIMUM_WORK_POLICY/)
    assert.match(runner, /"status": trial_classification\["status"\]/)
    assert.match(runner, /"verifierReward": verifier_reward/)
    assert.match(runner, /"officialReward": \([\s\S]*? == "scored" else None\s*\)/)

    const workflow = readFileSync('.github/workflows/skillsbench-scaleway-spike.yml', 'utf8')
    assert.match(workflow, /status: \.status/)
    assert.match(workflow, /voidReason: \.voidReason/)
    assert.match(workflow, /void trials: \$\{voids\}/)
  })
})
