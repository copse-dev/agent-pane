import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTO_APPROVAL_LEVELS,
  effectiveAutoApprovalLevel,
  type AutoApprovalLevel,
} from './auto-approval.ts'

describe('effectiveAutoApprovalLevel', () => {
  it('leaves every configured level unchanged when the OS sandbox is active', () => {
    for (const level of AUTO_APPROVAL_LEVELS) {
      assert.equal(effectiveAutoApprovalLevel(level, true), level)
    }
  })

  it('caps write tiers at read when no OS sandbox can contain them', () => {
    const withoutSandbox: ReadonlyArray<readonly [AutoApprovalLevel, AutoApprovalLevel]> = [
      ['off', 'off'],
      ['read', 'read'],
      ['local-write', 'read'],
      ['remote-write', 'read'],
    ]
    for (const [configured, expected] of withoutSandbox) {
      assert.equal(effectiveAutoApprovalLevel(configured, false), expected)
    }
  })
})
