import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AUTOMATION_FAILURE_CODES } from './types/automations.ts'
import {
  AUTOMATION_APPROVAL_STALL_MS,
  classifyAutomationFailureMessage,
  describeAutomationFailure,
  isApprovalStalled,
} from './automation-failure.ts'

describe('automation failures', () => {
  it('describes every code with a remedy and an action label', () => {
    for (const code of AUTOMATION_FAILURE_CODES) {
      const description = describeAutomationFailure(code)
      assert.ok(description.title.length > 0, code)
      assert.ok(description.remedy.length > 0, code)
      assert.ok(description.actionLabel.length > 0, code)
    }
  })

  it('classifies messages by their cause', () => {
    assert.equal(classifyAutomationFailureMessage('401 Unauthorized'), 'auth-expired')
    assert.equal(
      classifyAutomationFailureMessage('Docker is unavailable: cannot connect'),
      'container-missing',
    )
    assert.equal(classifyAutomationFailureMessage('The model gpt-x was not found'), 'no-model')
    assert.equal(
      classifyAutomationFailureMessage('Isolated worktree is unavailable: submodules unsupported'),
      'worktree-failed',
    )
    assert.equal(classifyAutomationFailureMessage('socket hang up'), 'unknown')
  })

  it('calls an approval stalled only after the threshold', () => {
    const now = 10_000_000
    assert.equal(isApprovalStalled(null, now), false)
    assert.equal(isApprovalStalled(now - AUTOMATION_APPROVAL_STALL_MS + 1, now), false)
    assert.equal(isApprovalStalled(now - AUTOMATION_APPROVAL_STALL_MS, now), true)
  })
})
