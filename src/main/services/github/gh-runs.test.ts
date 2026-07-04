import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatGhRunList,
  truncateLogTail,
  isFailingConclusion,
  GH_RUN_LOG_MAX_CHARS,
} from './gh-service.ts'

describe('isFailingConclusion', () => {
  it('treats failure, error, and timed_out as failing (case-insensitive)', () => {
    assert.equal(isFailingConclusion('FAILURE'), true)
    assert.equal(isFailingConclusion('error'), true)
    assert.equal(isFailingConclusion('Timed_Out'), true)
  })

  it('treats success and missing values as not failing', () => {
    assert.equal(isFailingConclusion('SUCCESS'), false)
    assert.equal(isFailingConclusion(''), false)
    assert.equal(isFailingConclusion(undefined), false)
    assert.equal(isFailingConclusion(null), false)
  })
})

describe('formatGhRunList', () => {
  it('formats run entries with id, workflow, outcome, branch, and url', () => {
    const out = formatGhRunList([
      {
        databaseId: 123,
        workflowName: 'CI',
        headBranch: 'feature',
        headSha: 'abcdef1234567',
        conclusion: 'failure',
        url: 'https://github.com/o/r/actions/runs/123',
      },
    ])
    assert.match(out, /#123 CI: FAILURE \(feature @ abcdef1\)/)
    assert.match(out, /https:\/\/github.com\/o\/r\/actions\/runs\/123/)
  })

  it('falls back to status when conclusion is missing', () => {
    const out = formatGhRunList([{ databaseId: 1, workflowName: 'CI', status: 'in_progress' }])
    assert.match(out, /#1 CI: IN_PROGRESS/)
  })

  it('reports an empty list', () => {
    assert.equal(formatGhRunList([]), '(no workflow runs)')
  })
})

describe('truncateLogTail', () => {
  it('returns the text unchanged when within the limit', () => {
    assert.equal(truncateLogTail('short log', 100), 'short log')
  })

  it('keeps the tail and notes how much was dropped', () => {
    const text = 'a'.repeat(50) + 'TAIL_ERROR'
    const out = truncateLogTail(text, 10)
    assert.match(out, /truncated/)
    assert.ok(out.endsWith('TAIL_ERROR'))
  })

  it('uses a sane default cap', () => {
    const cap: number = GH_RUN_LOG_MAX_CHARS
    assert.ok(cap > 0)
  })
})
