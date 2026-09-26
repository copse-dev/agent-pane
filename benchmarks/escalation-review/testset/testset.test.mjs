import assert from 'node:assert/strict'
import test from 'node:test'
import { TIERS } from '../scripts/score.mjs'
import { build, family, jsonl, relocateShellScope } from './build.mjs'
import { SNAPSHOT, analyzeTestset, drift, loadTestset, violations } from './gates.mjs'
import { parseCsv, shuffle } from './sample-hf.mjs'
import { accuracy, predicted } from './score-models.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TESTSET } from './paths.mjs'

test('the committed test set and fixtures are current', () => {
  for (const [name, content] of Object.entries(build())) {
    assert.equal(readFileSync(join(TESTSET, name), 'utf8'), content, `${name} is stale`)
  }
})

test('every case is labelled, anonymised and attributed', () => {
  const cases = loadTestset()
  assert.ok(cases.length >= 700)
  for (const c of cases) {
    assert.ok(TIERS.includes(c.tier), c.id)
    assert.ok(['dev', 'holdout'].includes(c.split), c.id)
    assert.ok(c.rationale, `${c.id} records why it has its tier`)
    for (const [, user] of JSON.stringify(c).matchAll(/\/Users\/([^/\s"'\\]+)/g)) {
      assert.equal(user, 'dev', `${c.id} uses only the anonymised home`)
    }
    if (c.source.startsWith('hf:')) assert.match(c.source, /@[0-9a-f]{12}:test#\d+$/u, c.id)
  }
  const tiers = new Set(cases.map((c) => c.tier))
  assert.deepEqual([...tiers].sort(), [...TIERS].sort(), 'every tier is represented')
})

test('the deterministic gates match the committed snapshot and keep their invariants', async () => {
  const cases = loadTestset()
  const verdicts = (await analyzeTestset(cases)).map((a) => a.verdict)
  const tiers = new Map(cases.map((c) => [c.id, c.tier]))
  assert.deepEqual(drift(jsonl(SNAPSHOT), verdicts, tiers), [])
  assert.deepEqual(violations(cases, verdicts), [])
})

test('drift marks the direction of each change', () => {
  const base = { autoApproval: { read: null, 'local-write': null, 'remote-write': null } }
  const before = [{ id: 'a', ...base, scope: 'external', readOutside: false, harm: 'prompt' }]
  const after = [{ id: 'a', ...base, scope: 'external', readOutside: false, harm: 'allow' }]
  assert.deepEqual(drift(before, after, new Map([['a', 'ask']])), [
    { id: 'a', field: 'harm', from: 'prompt', to: 'allow', direction: 'relaxed', tier: 'ask' },
  ])
  assert.equal(drift(after, before, new Map())[0].direction, 'tightened')
})

test('model scoring treats failures as wrong and ties as ask', () => {
  const record = (tier, probabilities, extra = {}) => ({
    id: tier,
    expected: { tier },
    result: { answers: { tier: { type: 'choice', probabilities } } },
    ...extra,
  })
  assert.equal(predicted(record('read', { read: 0.5, ask: 0.5 })), 'ask')
  const result = accuracy([
    record('read', { read: 0.9, ask: 0.1 }),
    record('ask', { read: 0.9, ask: 0.1 }),
    record('ask', { ask: 1 }, { error: 'timeout' }),
  ])
  assert.equal(result.correct, 1)
  assert.equal(result.valid, 2)
  assert.equal(result.askRecall, 0)
  assert.equal(result.confusion.ask.none, 1)
})

test('helpers: family, relocation, CSV and the seeded shuffle', () => {
  assert.equal(family('FOO=1 git push origin main'), 'git push')
  assert.equal(family('/usr/bin/cat x'), 'cat')
  assert.equal(
    relocateShellScope('cat /workspace/project/a /workspace/other/b /home/user/c'),
    'cat /Users/dev/project/a /Users/dev/other/b /Users/dev/c',
  )
  assert.deepEqual(parseCsv('a,b\n"x, ""y""",2\n'), [{ a: 'x, "y"', b: '2' }])
  assert.deepEqual(shuffle([1, 2, 3, 4]), shuffle([1, 2, 3, 4]))
})
