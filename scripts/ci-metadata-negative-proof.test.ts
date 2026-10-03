import assert from 'node:assert/strict'
import { it } from 'node:test'

it('keeps this never-admitted CI identity proof red', () => {
  assert.fail('Controlled negative fixture: this draft must never be merged or admitted to the queue')
})
