import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  approveAllStagedDiffs,
  approveStagedDiff,
  listStagedDiffEntries,
  reviewRemoteStagedDiff,
} from './diff-queue.ts'

/** A staged edit a turn-host turn made, shown in this window's diff panel. */
const owner = { projectId: 'p-remote', threadId: 't-remote' }
const entry = { path: 'notes.md', before: 'old\n', after: 'new\n', language: 'markdown' }

describe('a remote staged edit', () => {
  it('shows in the panel and answers the host when approved, writing nothing here', async () => {
    const reviewed = reviewRemoteStagedDiff(owner, entry, new AbortController().signal)
    assert.deepEqual(
      listStagedDiffEntries(owner).map((e) => e.path),
      ['notes.md'],
    )
    // No execution root is known here: a local apply would fail, a remote one never runs.
    await approveStagedDiff('notes.md', owner)
    assert.equal(await reviewed, true)
    assert.deepEqual(listStagedDiffEntries(owner), [])
  })

  it('answers each remote row on approve-all', async () => {
    const first = reviewRemoteStagedDiff(owner, entry, new AbortController().signal)
    const second = reviewRemoteStagedDiff(
      owner,
      { ...entry, path: 'other.md' },
      new AbortController().signal,
    )
    await approveAllStagedDiffs(owner)
    assert.deepEqual([await first, await second], [true, true])
    assert.deepEqual(listStagedDiffEntries(owner), [])
  })

  it('comes down unapproved when the host stops waiting, or asks again', async () => {
    const controller = new AbortController()
    const stopped = reviewRemoteStagedDiff(owner, entry, controller.signal)
    controller.abort()
    assert.equal(await stopped, false)
    assert.deepEqual(listStagedDiffEntries(owner), [])

    const older = reviewRemoteStagedDiff(owner, entry, new AbortController().signal)
    const newer = reviewRemoteStagedDiff(
      owner,
      { ...entry, after: 'newer\n' },
      new AbortController().signal,
    )
    assert.equal(await older, false)
    assert.deepEqual(
      listStagedDiffEntries(owner).map((e) => e.after),
      ['newer\n'],
    )
    await approveStagedDiff('notes.md', owner)
    assert.equal(await newer, true)
  })
})
