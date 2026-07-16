import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeToolExecuteResult } from './wire-types.ts'

describe('normalizeToolExecuteResult', () => {
  it('wraps a bare string as a plain result', () => {
    assert.deepEqual(normalizeToolExecuteResult('done'), { result: 'done' })
  })

  it('passes through edit stats', () => {
    assert.deepEqual(
      normalizeToolExecuteResult({ result: 'edited', editStats: { additions: 2, deletions: 1 } }),
      {
        result: 'edited',
        editStats: { additions: 2, deletions: 1 },
      },
    )
  })

  it('passes through the markdown result format so prose tools render richly', () => {
    assert.deepEqual(normalizeToolExecuteResult({ result: '# advice', resultFormat: 'markdown' }), {
      result: '# advice',
      resultFormat: 'markdown',
    })
  })
})
