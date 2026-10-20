import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setImmediate } from 'node:timers/promises'
import { configureThreadStore } from '@copse/thread-store/environment.ts'
import { createThread } from '../thread-store.ts'
import { storageSet } from '../storage/storage.ts'
import { mobileActivity } from './mobile-activity.ts'
import { MobileActivityChanges } from './mobile-activity-changes.ts'

describe('mobileActivity dirty-state inspection', () => {
  it('resolves checkouts without restoring retired worktrees', async () => {
    const source = await readFile(new URL('./mobile-activity.ts', import.meta.url), 'utf8')
    const start = source.indexOf('async function settledThreadHasChanges(')
    const end = source.indexOf('export async function mobileActivity(')
    assert.ok(start !== -1 && end > start, 'settledThreadHasChanges block not found')
    const block = source.slice(start, end)
    assert.match(block, /inspectThreadCheckoutRoot\(/)
    // Resolution restores a retired worktree with `git worktree add`, so an
    // activity poll must never go through it.
    assert.doesNotMatch(source, /resolveThreadExecutionContext/)
  })

  it('returns the feed before a dirty check settles and regroups on a subsequent poll', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'copse-mobile-activity-'))
    configureThreadStore({ workspaceRoot: () => directory })
    storageSet('projects', [{ id: 'project', name: 'Project' }])
    const inspection = Promise.withResolvers<boolean>()
    const changes = new MobileActivityChanges(() => inspection.promise)
    try {
      await createThread('project', {
        id: 'thread',
        title: 'Finished work',
        messages: [
          { id: 'user', role: 'user', content: 'Review this', toolCalls: [], createdAt: 1 },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: 1,
        updatedAt: 1,
        status: 'idle',
      })
      const cold = await mobileActivity(changes)
      assert.equal(cold.length, 1)
      assert.equal(cold[0]?.title, 'Finished work')
      assert.equal(cold[0].group, 'recent')
      inspection.resolve(true)
      await setImmediate()
      assert.equal((await mobileActivity(changes))[0]?.group, 'has-changes')
    } finally {
      inspection.resolve(false)
      storageSet('projects', [])
      await rm(directory, { recursive: true, force: true })
    }
  })
})
