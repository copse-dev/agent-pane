import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { decodeReviewCase } from '@copse/review/eval.ts'
import { safeJsonParse } from '@copse/std/safe-json.ts'
import { resolveLenses } from '@copse/review/lenses.ts'

const cases = [
  'filter-refresh',
  'resize-without-scroll',
  'workspace-switch-inflight',
  'dispose-inflight',
  'shortcut-autorepeat',
]

describe('state-transition corpus oracles', () => {
  for (const name of cases) {
    for (const clean of [false, true]) {
      const id = name + (clean ? '-clean' : '')
      it(`${id}: shallow tests stay green; the transition probe distinguishes the regression`, async () => {
        const root = resolve('benchmarks/review/cases', id)
        const metadata = safeJsonParse(
          await readFile(resolve(root, 'case.json'), 'utf8'),
          decodeReviewCase,
        )
        assert.ok(metadata)
        assert.equal(metadata.truth.length, clean ? 0 : 1)
        for (const target of ['base', 'head']) {
          const cwd = resolve(root, target)
          const smoke = spawnSync(process.execPath, ['test.cjs'], { cwd, encoding: 'utf8' })
          assert.equal(smoke.status, 0, smoke.stderr)
          const probe = spawnSync(process.execPath, [resolve(root, 'probe.cjs'), cwd], {
            encoding: 'utf8',
          })
          assert.equal(probe.status, target === 'head' && !clean ? 1 : 0, probe.stderr)
          if (target === 'head' && !clean) assert.match(probe.stderr, /AssertionError/)
        }
      })
    }
  }
  it('offers the transition tactic without changing the default review profile', () => {
    assert.deepEqual(
      resolveLenses(undefined).map((lens) => lens.id),
      ['correctness'],
    )
    const [lens] = resolveLenses('transitions')
    assert.ok(lens)
    assert.match(lens.brief, /workspace switches.*requests/)
    assert.match(lens.brief, /resize with unchanged scroll offsets/)
    assert.match(lens.brief, /missing test is not a separate finding/)
  })
})
