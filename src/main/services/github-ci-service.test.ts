import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveOverallState,
  ghPrHasCiFailures,
  normalizeCheckBucket,
  parseGhPrChecks,
  pickLatestRunForHead,
  rollupToCiChecks,
} from './github-ci-service.ts'

describe('normalizeCheckBucket', () => {
  it('maps known buckets', () => {
    assert.equal(normalizeCheckBucket('pass'), 'pass')
    assert.equal(normalizeCheckBucket('fail'), 'fail')
    assert.equal(normalizeCheckBucket('pending'), 'pending')
  })

  it('returns unknown for unexpected values', () => {
    assert.equal(normalizeCheckBucket('weird'), 'unknown')
  })
})

describe('rollupToCiChecks', () => {
  it('maps check runs and status contexts', () => {
    const checks = rollupToCiChecks([
      { __typename: 'CheckRun', name: 'check', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'StatusContext', context: 'ci/circle', state: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS' },
    ])
    assert.equal(checks.length, 3)
    assert.equal(checks[0]?.name, 'check')
    assert.equal(checks[0]?.bucket, 'fail')
    assert.equal(checks[1]?.name, 'ci/circle')
    assert.equal(checks[1]?.bucket, 'pass')
    assert.equal(checks[2]?.name, 'lint')
    assert.equal(checks[2]?.bucket, 'pending')
  })
})

describe('deriveOverallState', () => {
  it('returns pending when any check is pending', () => {
    assert.equal(
      deriveOverallState([
        { name: 'a', state: 'SUCCESS', bucket: 'pass' },
        { name: 'b', state: 'IN_PROGRESS', bucket: 'pending' },
      ]),
      'pending',
    )
  })

  it('returns failure when any check failed', () => {
    assert.equal(
      deriveOverallState([
        { name: 'a', state: 'SUCCESS', bucket: 'pass' },
        { name: 'b', state: 'FAILURE', bucket: 'fail' },
      ]),
      'failure',
    )
  })

  it('returns success when all checks passed', () => {
    assert.equal(
      deriveOverallState([
        { name: 'a', state: 'SUCCESS', bucket: 'pass' },
        { name: 'b', state: 'SUCCESS', bucket: 'pass' },
      ]),
      'success',
    )
  })
})

describe('parseGhPrChecks', () => {
  it('parses gh pr checks JSON rows', () => {
    const checks = parseGhPrChecks(
      JSON.stringify([
        { name: 'check', state: 'FAIL', bucket: 'fail', link: 'https://example.com' },
      ]),
    )
    assert.equal(checks.length, 1)
    assert.equal(checks[0]?.name, 'check')
    assert.equal(checks[0]?.state, 'FAIL')
    assert.equal(checks[0]?.bucket, 'fail')
    assert.equal(checks[0]?.link, 'https://example.com')
  })
})

describe('ghPrHasCiFailures', () => {
  it('detects failed rollup checks', () => {
    assert.equal(
      ghPrHasCiFailures({
        statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }],
      }),
      true,
    )
  })
})

describe('pickLatestRunForHead', () => {
  it('prefers the run matching the PR head sha', () => {
    const runs = [
      { databaseId: 1, headSha: 'old' },
      { databaseId: 2, headSha: 'head' },
      { databaseId: 3, headSha: 'other' },
    ]
    assert.deepEqual(pickLatestRunForHead(runs, 'head'), { databaseId: 2, headSha: 'head' })
  })

  it('falls back to the newest listed run', () => {
    const runs = [{ databaseId: 9, headSha: 'old' }]
    assert.deepEqual(pickLatestRunForHead(runs, 'missing'), { databaseId: 9, headSha: 'old' })
  })
})
