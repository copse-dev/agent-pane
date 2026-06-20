import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseDiffNumstat,
  porcelainHasMergeConflicts,
  ghPrHasCiFailures,
  ghPrHasMergeConflicts,
} from './pr-context-service.ts'
import { parseModelFollowUpIds } from './follow-up-service.ts'

describe('parseDiffNumstat', () => {
  it('sums additions and deletions', () => {
    const raw = '3\t1\tfile.ts\0\n10\t5\tother.ts\n'
    assert.deepEqual(parseDiffNumstat(raw), { additions: 13, deletions: 6 })
  })

  it('ignores binary placeholder dashes', () => {
    const raw = '-\t-\tbinary.png\n2\t0\ttext.ts\n'
    assert.deepEqual(parseDiffNumstat(raw), { additions: 2, deletions: 0 })
  })
})

describe('porcelainHasMergeConflicts', () => {
  it('detects unmerged paths', () => {
    const raw = 'UU src/conflict.ts\0'
    assert.equal(porcelainHasMergeConflicts(raw), true)
  })

  it('returns false for a clean tree', () => {
    const raw = ' M src/foo.ts\0'
    assert.equal(porcelainHasMergeConflicts(raw), false)
  })
})

describe('gh PR helpers', () => {
  it('detects CI failures', () => {
    assert.equal(
      ghPrHasCiFailures({
        statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }],
      }),
      true,
    )
  })

  it('detects merge conflicts from mergeable', () => {
    assert.equal(ghPrHasMergeConflicts({ mergeable: 'CONFLICTING' }), true)
    assert.equal(ghPrHasMergeConflicts({ mergeable: 'MERGEABLE' }), false)
  })
})

describe('parseModelFollowUpIds', () => {
  it('parses a JSON array from model output', () => {
    assert.deepEqual(parseModelFollowUpIds('Here: ["run-tests", "explain"]'), [
      'run-tests',
      'explain',
    ])
  })

  it('returns empty array on invalid JSON', () => {
    assert.deepEqual(parseModelFollowUpIds('no json here'), [])
  })
})
