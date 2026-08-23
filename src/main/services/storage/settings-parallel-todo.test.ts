import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getSettingSchema } from './settings-schema.ts'

describe('parallel todo worker settings registration', () => {
  it('registers schemas for both parallel-worker keys', () => {
    assert.ok(
      getSettingSchema('parallelTodoWorkersEnabled'),
      'parallelTodoWorkersEnabled must be registered so settings:get does not null it out',
    )
    assert.ok(getSettingSchema('todoWorkerParallelism'), 'todoWorkerParallelism must be registered')
  })

  it('validates the parallelism range', () => {
    const schema = getSettingSchema('todoWorkerParallelism')
    assert.ok(schema)
    assert.equal(schema.safeParse(2).success, true)
    assert.equal(schema.safeParse(0).success, false)
    assert.equal(schema.safeParse(5).success, false)
  })
})
