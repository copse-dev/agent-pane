import assert from 'node:assert/strict'
import { it } from 'node:test'
import { roadmapThreadIds } from './note.ts'

it('reads legacy links and preserves unique attempts in most-recent order', () => {
  assert.deepEqual(roadmapThreadIds({ thread: 'legacy' }), ['legacy'])
  assert.deepEqual(
    roadmapThreadIds({ thread: 'latest', threadHistory: '["earlier","latest","earlier"]' }),
    ['latest', 'earlier'],
  )
})

it('ignores malformed or wrongly typed history while retaining the current link', () => {
  for (const threadHistory of ['broken', '{}', '[1]', '[""]']) {
    assert.deepEqual(roadmapThreadIds({ thread: 'latest', threadHistory }), ['latest'])
  }
})
