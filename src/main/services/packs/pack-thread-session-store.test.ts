import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  persistentPackThreadSessionStore,
  validatePackThreadSessionState,
} from './pack-thread-session-store.ts'

describe('pack thread session state', () => {
  it('accepts bounded JSON and rejects non-serializable or oversized state', () => {
    assert.doesNotThrow(() => {
      validatePackThreadSessionState({ externalId: 'chat-42' })
    })
    assert.throws(() => {
      validatePackThreadSessionState(undefined)
    }, /JSON serializable/i)
    assert.throws(() => {
      validatePackThreadSessionState(1n)
    }, /JSON serializable/i)
    assert.throws(() => {
      validatePackThreadSessionState('x'.repeat(256 * 1024))
    }, /exceeds 256 KB/i)
  })

  it('round-trips and deletes state through persistent pack/thread namespacing', async () => {
    const packId = 'test.personal-session'
    const threadId = 'thread-round-trip'
    await persistentPackThreadSessionStore.delete(packId, threadId)
    assert.equal(await persistentPackThreadSessionStore.get(packId, threadId), null)

    await persistentPackThreadSessionStore.set(packId, threadId, { externalId: 'chat-42' })
    assert.deepEqual(await persistentPackThreadSessionStore.get(packId, threadId), {
      externalId: 'chat-42',
    })

    await persistentPackThreadSessionStore.delete(packId, threadId)
    assert.equal(await persistentPackThreadSessionStore.get(packId, threadId), null)
  })
})
