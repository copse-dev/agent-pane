import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { openDeepLinkThread } from './deep-link-navigation.ts'

describe('deep-link renderer navigation', () => {
  it('opens the stored project even when another project is active', () => {
    const store = createStore({
      projects: [
        { id: 'a', path: '/a', name: 'A' },
        { id: 'b', path: '/b', name: 'B' },
      ],
      activeProjectId: 'b',
    })
    const opened: string[] = []
    assert.equal(
      openDeepLinkThread(store, { threadId: 'thread', projectId: 'a' }, (p, t) =>
        opened.push(`${p}/${t}`),
      ),
      true,
    )
    assert.deepEqual(opened, ['a/thread'])
  })

  it('leaves navigation unchanged for missing, ambiguous or removed projects', () => {
    const store = createStore({
      projects: [{ id: 'a', path: '/a', name: 'A' }],
      activeProjectId: 'a',
    })
    for (const projectId of [null, 'removed']) {
      assert.equal(
        openDeepLinkThread(store, { threadId: 'thread', projectId }, () =>
          assert.fail('must not navigate'),
        ),
        false,
      )
    }
    assert.equal(store.getState().activeProjectId, 'a')
  })
})
