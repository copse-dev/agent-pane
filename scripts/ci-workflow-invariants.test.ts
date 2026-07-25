import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Structural pins for `.github/workflows/ci.yml` contracts that unit tests
 * can enforce without spinning Actions. Keep these narrow — they exist to
 * catch accidental regressions of known fail-closed / skip-mode gotchas.
 */
describe('ci.yml workflow invariants', () => {
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')

  it('skips the e2e job when the oracle plans zero shards (empty matrix is a GHA failure)', () => {
    // GitHub Actions treats `strategy.matrix: []` as job failure, not skipped.
    // Zero-shard plans (mode=skip / empty subset) must therefore gate the job
    // via `e2e_shard_total` so `needs.e2e.result` is 'skipped' and the
    // mode=skip branch of `ci-passed` can accept the run (#1233).
    const e2eJob = workflow.match(/^  e2e:\n(?:    .*\n)+/m)?.[0]
    assert.ok(e2eJob, 'expected an `e2e:` job in ci.yml')
    assert.match(
      e2eJob,
      /needs\.precheck\.outputs\.e2e_shard_total\s*!=\s*'0'/,
      'e2e job if: must require e2e_shard_total != 0 so empty matrices never evaluate',
    )
  })
})
