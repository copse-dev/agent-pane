import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findAsync } from '../tests/e2e/helpers/find-async.ts'

describe('asynchronous fixture searches', () => {
  it('awaits predicates and stops at the first matching element', async () => {
    const visited: number[] = []
    const result = await findAsync([1, 2, 3], async (value) => {
      visited.push(value)
      return Promise.resolve(value === 2)
    })
    assert.equal(result, 2)
    assert.deepEqual(visited, [1, 2])
  })
  it('reports a missing match and propagates predicate failures', async () => {
    assert.equal(await findAsync([1], () => Promise.resolve(false)), undefined)
    await assert.rejects(
      findAsync([1], () => Promise.reject(new Error('query failed'))),
      /query failed/,
    )
  })
})
