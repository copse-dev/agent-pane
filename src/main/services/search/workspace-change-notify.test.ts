import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  flushWorkspaceChangeNotify,
  notifyWorkspaceChanged,
  resetWorkspaceChangeNotifyForTest,
  setWorkspaceChangeSink,
  shouldPublishWorkingTreeChange,
} from './workspace-change-notify.ts'

describe('shouldPublishWorkingTreeChange', () => {
  it('publishes ordinary paths and tracked generated trees', () => {
    for (const path of [
      'src/app.ts',
      'node_modules/tracked-generated.js',
      'dist/main.js',
      'README.md',
    ]) {
      assert.equal(shouldPublishWorkingTreeChange(path), true, path)
    }
  })

  it('publishes .git HEAD and index, including Windows separators', () => {
    assert.equal(shouldPublishWorkingTreeChange('.git/HEAD'), true)
    assert.equal(shouldPublishWorkingTreeChange('.git/index'), true)
    assert.equal(shouldPublishWorkingTreeChange('.git\\HEAD'), true)
    assert.equal(shouldPublishWorkingTreeChange('.git\\index'), true)
  })

  it('drops .git object, log, and lock churn', () => {
    for (const path of [
      '.git/objects/ab/cdef',
      '.git/logs/HEAD',
      '.git/index.lock',
      '.git/refs/heads/main',
    ]) {
      assert.equal(shouldPublishWorkingTreeChange(path), false, path)
    }
  })

  it('publishes an omitted filename as an unknown change', () => {
    assert.equal(shouldPublishWorkingTreeChange(null), true)
  })
})

describe('notifyWorkspaceChanged', () => {
  afterEach(() => {
    resetWorkspaceChangeNotifyForTest()
  })

  it('coalesces a burst for one root into a single delivery', () => {
    const delivered: string[] = []
    setWorkspaceChangeSink((root) => delivered.push(root))

    notifyWorkspaceChanged('/repo-a')
    notifyWorkspaceChanged('/repo-a')
    notifyWorkspaceChanged('/repo-b')
    flushWorkspaceChangeNotify()

    assert.deepEqual(delivered, ['/repo-a', '/repo-b'])
  })
})
