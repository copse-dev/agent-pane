// The `storage:get` / `storage:set` key allowlist (issue #1685).
//
// This exists because a renderer-only storage key is invisible to every renderer
// test: component tests stub `storage` with a plain object that has no
// allowlist, so reading an unlisted key passes there and throws only over real
// IPC. `loadProjects` is awaited during boot without a catch, so that throw does
// not degrade one feature — it aborts the layout mount, and the app comes up
// with no composer, no chat and no panes. The e2e tier caught it as
// `.prompt-input still not existing`, several tiers and ~20 minutes of CI away
// from the one-line cause.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assertStorageKey, IpcValidationError } from './ipc-guards.ts'
import { RENDERER_STORAGE_KEYS } from '@shared/storage-keys.ts'

describe('assertStorageKey', () => {
  it('allows every key the renderer persists', () => {
    for (const key of RENDERER_STORAGE_KEYS) {
      assert.doesNotThrow(() => {
        assertStorageKey(key)
      }, `${key} must be readable and writable by the renderer`)
    }
  })

  it('covers the keys persistence.ts actually uses', () => {
    // Spelled out rather than derived, so dropping one from the shared list is a
    // failure here instead of a silently narrower allowlist.
    assert.deepEqual([...RENDERER_STORAGE_KEYS].sort(), [
      'activeProjectId',
      'projectGroups',
      'projects',
    ])
  })

  it('rejects a key outside the allowlist', () => {
    for (const key of ['settings', 'apiKeys', '__proto__', 'projects2', '']) {
      assert.throws(
        () => {
          assertStorageKey(key)
        },
        IpcValidationError,
        `${JSON.stringify(key)} must not be reachable from the renderer`,
      )
    }
  })
})
