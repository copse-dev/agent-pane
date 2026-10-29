import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { storageGet, storageSet } from './storage/storage.ts'
import { getWorkspaceRoot, setWorkspaceRoot, setWorkspaceRootForTest } from './workspace.ts'

// Kept in its own file: the seed is process state, so nothing may call
// `getWorkspaceRoot` before these cases run.
describe('workspace root seeding', () => {
  it('reads the persisted root on first use, not when the module loads', () => {
    // Written after workspace.ts was imported, as a backend installed or
    // populated later in startup would be.
    storageSet('workspaceRoot', '/persisted/project')

    assert.equal(getWorkspaceRoot(), '/persisted/project')
  })

  it('keeps the in-process root once seeded and persists changes', () => {
    setWorkspaceRoot('/selected/project')
    assert.equal(getWorkspaceRoot(), '/selected/project')
    assert.equal(storageGet('workspaceRoot'), '/selected/project')

    const restore = setWorkspaceRootForTest('/temporary')
    assert.equal(getWorkspaceRoot(), '/temporary')
    restore()
    assert.equal(getWorkspaceRoot(), '/selected/project')
  })
})
