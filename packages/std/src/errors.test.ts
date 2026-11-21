import assert from 'node:assert/strict'
import { it } from 'node:test'
import { aggregateFailure } from './errors.ts'

it('names each bounded cause in an aggregate failure message', () => {
  const long = new Error('x'.repeat(400))
  const error = aggregateFailure(
    [new Error('Command failed: container delete\n  timed out'), 'plain', long],
    'Failed to stop',
  )
  assert.ok(error instanceof AggregateError)
  assert.equal(error.errors.length, 3)
  assert.match(
    error.message,
    /^Failed to stop: Command failed: container delete timed out; plain; x+…$/,
  )
  assert.ok(error.message.length < 400)
})
