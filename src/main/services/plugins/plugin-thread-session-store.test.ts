import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  persistentPluginThreadSessionStore,
  validatePluginThreadSessionState,
} from './plugin-thread-session-store.ts'

describe('plugin thread session state', () => {
  it('accepts bounded JSON and rejects non-serializable or oversized state', () => {
    assert.doesNotThrow(() => {
      validatePluginThreadSessionState({ externalId: 'chat-42' })
    })
    assert.throws(() => {
      validatePluginThreadSessionState(undefined)
    }, /JSON serializable/i)
    assert.throws(() => {
      validatePluginThreadSessionState(1n)
    }, /JSON serializable/i)
    assert.throws(() => {
      validatePluginThreadSessionState('x'.repeat(256 * 1024))
    }, /exceeds 256 KB/i)
  })

  it('round-trips and deletes state through persistent plugin/thread namespacing', async () => {
    const pluginId = 'test.personal-session'
    const threadId = 'thread-round-trip'
    await persistentPluginThreadSessionStore.delete(pluginId, threadId)
    assert.equal(await persistentPluginThreadSessionStore.get(pluginId, threadId), null)

    await persistentPluginThreadSessionStore.set(pluginId, threadId, { externalId: 'chat-42' })
    assert.deepEqual(await persistentPluginThreadSessionStore.get(pluginId, threadId), {
      externalId: 'chat-42',
    })

    await persistentPluginThreadSessionStore.delete(pluginId, threadId)
    assert.equal(await persistentPluginThreadSessionStore.get(pluginId, threadId), null)
  })
})
