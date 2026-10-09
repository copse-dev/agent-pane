import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  beginWorktreeWriter,
  hasLiveWorktreeWriter,
  noteWorktreeWrite,
  withWorktreeWriter,
  worktreeWriteEpoch,
} from './worktree-writers.ts'

const ROOT = join(tmpdir(), 'copse-writers-root')

describe('worktree writer registry', () => {
  void it('holds a writer live until it is released, advancing the epoch both ways', () => {
    const start = worktreeWriteEpoch()
    const release = beginWorktreeWriter(ROOT)
    assert.equal(hasLiveWorktreeWriter(ROOT), true)
    assert.equal(worktreeWriteEpoch(), start + 1)

    release()
    assert.equal(hasLiveWorktreeWriter(ROOT), false)
    assert.equal(worktreeWriteEpoch(), start + 2)

    // Every exit path of a writer may call release; only the first counts.
    release()
    assert.equal(worktreeWriteEpoch(), start + 2)
  })

  void it('matches a writer running in, above, or below the root, but not beside it', () => {
    const cases: Array<[scope: string, live: boolean]> = [
      [ROOT, true],
      [join(ROOT, 'packages', 'app'), true],
      [join(ROOT, '..'), true],
      [`${ROOT}-sibling`, false],
      [join(tmpdir(), 'elsewhere'), false],
    ]
    for (const [scope, live] of cases) {
      const release = beginWorktreeWriter(scope)
      try {
        assert.equal(hasLiveWorktreeWriter(ROOT), live, scope)
      } finally {
        release()
      }
    }
  })

  void it('treats an unscoped writer as live on every root', () => {
    const release = beginWorktreeWriter(null)
    try {
      assert.equal(hasLiveWorktreeWriter(ROOT), true)
      assert.equal(hasLiveWorktreeWriter(join(tmpdir(), 'any-other-root')), true)
    } finally {
      release()
    }
  })

  void it('releases a scoped lease when the work throws', async () => {
    await assert.rejects(
      withWorktreeWriter(ROOT, async () => {
        assert.equal(hasLiveWorktreeWriter(ROOT), true)
        await Promise.resolve()
        throw new Error('install failed')
      }),
      /install failed/,
    )
    assert.equal(hasLiveWorktreeWriter(ROOT), false)
  })

  void it('advances the epoch for a one-shot write without leaving a writer live', () => {
    const start = worktreeWriteEpoch()
    noteWorktreeWrite()
    assert.equal(worktreeWriteEpoch(), start + 1)
    assert.equal(hasLiveWorktreeWriter(ROOT), false)
  })
})
