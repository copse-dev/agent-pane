import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildBranchCiStatus, getInteractiveCiStatus } from './branch-ci-status.ts'

const SHA = 'a'.repeat(40)
function run(
  status: string,
  conclusion: string,
): Parameters<typeof buildBranchCiStatus>[2][number] {
  return {
    databaseId: 123,
    workflowDatabaseId: 456,
    workflowName: 'CI',
    headBranch: 'main',
    headSha: SHA,
    event: 'push',
    status,
    conclusion,
    url: 'https://github.com/o/r/actions/runs/123',
  }
}

describe('branch push-workflow status', () => {
  it('requires completed passing evidence; active, cancelled and unknown are not success', () => {
    const cases: Array<[string, string, string]> = [
      ['queued', '', 'pending'],
      ['in_progress', '', 'pending'],
      ['completed', 'success', 'success'],
      ['completed', 'failure', 'failure'],
      ['completed', 'cancelled', 'failure'],
      ['completed', 'timed_out', 'failure'],
      ['completed', 'future_conclusion', 'pending'],
      ['completed', '', 'pending'],
      ['completed', 'skipped', 'pending'],
    ]
    for (const [status, conclusion, expected] of cases) {
      assert.equal(buildBranchCiStatus('main', SHA, [run(status, conclusion)]).overall, expected)
    }
    const active = buildBranchCiStatus('main', SHA, [run('in_progress', '')])
    assert.equal(active.checks[0]?.state, 'in_progress')
    assert.equal(active.scope, 'branch_push_workflows')
    assert.match(active.coverage, /PR-only checks and branch-protection requirements/)
  })

  it('keeps absent, mismatched, unidentified or limit-sized evidence pending', () => {
    const pass = run('completed', 'success')
    for (const rows of [
      [],
      [{ ...pass, headSha: 'b'.repeat(40) }],
      [{ ...pass, event: 'workflow_run' }],
      [{ ...pass, headBranch: 'other' }],
      [{ ...pass, workflowDatabaseId: undefined, workflowName: undefined }],
      [{ ...pass, workflowDatabaseId: undefined }],
      Array.from({ length: 100 }, (_, index) => ({ ...pass, workflowDatabaseId: index + 1 })),
      [pass, { ...pass, headSha: 'b'.repeat(40) }],
    ])
      assert.equal(buildBranchCiStatus('main', SHA, rows).overall, 'pending')
  })

  it('supersedes only the same workflow and keeps other pending workflows pending', () => {
    const pass = run('completed', 'success')
    const oldFailure = { ...run('completed', 'failure'), databaseId: 122 }
    assert.equal(buildBranchCiStatus('main', SHA, [pass, oldFailure]).overall, 'success')
    const cancelled = run('completed', 'cancelled')
    assert.equal(
      buildBranchCiStatus('main', SHA, [cancelled, { ...pass, databaseId: 122 }]).overall,
      'failure',
    )
    assert.equal(
      buildBranchCiStatus('main', SHA, [
        pass,
        {
          ...run('queued', ''),
          workflowDatabaseId: 789,
          workflowName: 'Release',
        },
      ]).overall,
      'pending',
    )
  })

  it('does not run branch queries without a caller workspace', async () => {
    await assert.rejects(getInteractiveCiStatus(undefined, null, 'main'), /No workspace/)
  })
})
