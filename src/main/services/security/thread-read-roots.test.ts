import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runWithActiveRunIdentity } from '../thread-models.ts'
import {
  activeThreadReadRootPaths,
  activeThreadReadRoots,
  clearThreadReadRoots,
  grantThreadReadRoot,
  threadReadRoots,
} from './thread-read-roots.ts'

const skillRoot = {
  path: '/Users/me/.codex/skills/reconcile-worktrees',
  canonical: '/Users/me/dev/skills/reconcile-worktrees',
  isDirectory: true,
  label: 'skill "reconcile-worktrees" directory',
}

describe('thread read roots', () => {
  afterEach(() => {
    clearThreadReadRoots()
  })

  it('is empty for an unknown thread and outside any run', () => {
    assert.deepEqual(threadReadRoots('nobody'), [])
    assert.deepEqual(threadReadRoots(null), [])
    assert.deepEqual(activeThreadReadRoots(), [])
    assert.deepEqual(activeThreadReadRootPaths(), [])
  })

  it('scopes a grant to the thread that earned it', () => {
    grantThreadReadRoot('thread-a', skillRoot)
    assert.deepEqual(threadReadRoots('thread-a'), [skillRoot])
    assert.deepEqual(threadReadRoots('thread-b'), [])
    assert.deepEqual(
      runWithActiveRunIdentity('thread-a', () => activeThreadReadRootPaths()),
      [skillRoot.path, skillRoot.canonical],
    )
    assert.deepEqual(
      runWithActiveRunIdentity('thread-b', () => activeThreadReadRootPaths()),
      [],
    )
  })

  it('dedupes by canonical path so re-invoking a skill adds nothing', () => {
    grantThreadReadRoot('thread-a', skillRoot)
    grantThreadReadRoot('thread-a', { ...skillRoot, label: 'again' })
    assert.equal(threadReadRoots('thread-a').length, 1)
    assert.equal(threadReadRoots('thread-a')[0]?.label, 'again')
  })

  it('reports one spelling when the root is not symlinked', () => {
    grantThreadReadRoot('thread-a', { ...skillRoot, canonical: skillRoot.path })
    assert.deepEqual(
      runWithActiveRunIdentity('thread-a', () => activeThreadReadRootPaths()),
      [skillRoot.path],
    )
  })

  it('clears one thread without touching another', () => {
    grantThreadReadRoot('thread-a', skillRoot)
    grantThreadReadRoot('thread-b', skillRoot)
    clearThreadReadRoots('thread-a')
    assert.deepEqual(threadReadRoots('thread-a'), [])
    assert.equal(threadReadRoots('thread-b').length, 1)
  })
})
