import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

// Invariants for the e2e dispatch path in .github/workflows/ci.yml.
//
// Both exist because of a live regression: #1230 sized the shard matrix to the
// oracle's plan and emitted an empty list when nothing was planned, assuming an
// empty matrix skips the job. It does not — GitHub FAILS a job whose matrix
// vector is empty ("Matrix vector 'shard' does not contain any values"), so
// every skip-mode run reported `e2e: failure` and tripped `ci-passed`.
// Resolved from the repo root, NOT from `import.meta.url`: run-tests.mts
// bundles specs into `dist-test/` before running them, so a module-relative
// path resolves inside the bundle output and the read throws ENOENT.
const WORKFLOW = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')

describe('ci.yml e2e dispatch invariants', () => {
  it('never emits an empty shard matrix', () => {
    // A non-empty placeholder keeps the job dispatchable-but-skippable
    // regardless of whether `if:` is evaluated before matrix expansion.
    assert.equal(
      /list=\[\]/.test(WORKFLOW),
      false,
      'an empty strategy.matrix vector fails the job instead of skipping it',
    )
  })

  it('guards the e2e job on the shard total, not the oracle mode', () => {
    // `mode` is the wrong signal: the subset-with-no-specs path keeps
    // mode=subset, so a `mode != 'skip'` guard lets it through and dispatches a
    // shard that finds an empty slice. `e2e_shard_total` covers both paths.
    assert.match(
      WORKFLOW,
      /needs\.precheck\.outputs\.e2e_shard_total != '0'/,
      'e2e must skip whenever the oracle planned zero shards',
    )
    assert.equal(
      /needs\.precheck\.outputs\.mode != 'skip' &&/.test(WORKFLOW),
      false,
      'a mode-based guard misses the subset-with-no-specs path',
    )
  })
})
