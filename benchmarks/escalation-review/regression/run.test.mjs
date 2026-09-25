import assert from 'node:assert/strict'
import test from 'node:test'
import { loadCases, mismatches, run } from './run.mjs'

test('every regression case agrees with its recorded status', async () => {
  const home = process.env.HOME
  const results = await run()
  assert.equal(process.env.HOME, home, 'the runner restores HOME')
  const disagreements = results.filter((r) => r.outcome === 'fail' || r.outcome === 'gap closed')
  assert.deepEqual(disagreements, [])
  assert.ok(results.some((r) => r.outcome === 'pass'))
})

test('cases are well formed', () => {
  const cases = loadCases()
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length)
  for (const c of cases) {
    assert.ok(['enforced', 'known-gap'].includes(c.status), c.id)
    assert.ok(Object.hasOwn(c.expect, 'harm') || Object.hasOwn(c.expect, 'read'), c.id)
    assert.equal(c.status === 'known-gap', Boolean(c.fix), `${c.id}: known gaps name their fix`)
    const text = JSON.stringify(c)
    for (const [, user] of text.matchAll(/\/Users\/([^/\s"'\\]+)/g)) {
      assert.equal(user, 'dev', `${c.id} uses only the anonymised home`)
    }
  }
})

test('mismatches accepts any listed harm action and treats null read as prompting', () => {
  const result = {
    harm: 'deny',
    harmReasons: ['x'],
    autoApproval: { read: null },
    autoApprovalReasons: ['y'],
  }
  assert.deepEqual(mismatches({ expect: { harm: ['prompt', 'deny'], read: null } }, result), [])
  assert.equal(mismatches({ expect: { harm: 'allow', read: 'read' } }, result).length, 2)
})
