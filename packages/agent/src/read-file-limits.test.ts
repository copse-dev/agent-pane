import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  readFileLimitsFromConversationBudget,
  READ_FILE_LIMITS_CEILING,
} from './read-file-limits.ts'

describe('readFileLimitsFromConversationBudget', () => {
  it('scales down for tight conversation budgets', () => {
    const limits = readFileLimitsFromConversationBudget(5000)
    assert.ok(limits.maxChars < READ_FILE_LIMITS_CEILING.maxChars)
    assert.ok(limits.maxLines < READ_FILE_LIMITS_CEILING.maxLines)
  })

  it('hits ceiling for large conversation budgets', () => {
    const limits = readFileLimitsFromConversationBudget(200_000)
    assert.equal(limits.maxChars, READ_FILE_LIMITS_CEILING.maxChars)
    assert.equal(limits.maxLines, READ_FILE_LIMITS_CEILING.maxLines)
  })
})
