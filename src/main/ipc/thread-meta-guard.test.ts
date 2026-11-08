import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureThreadStore } from '@copse/thread-store/environment.ts'
import { parseThreadValue } from '@shared/threads/thread-boundary.ts'
import { buildForkedThread } from '@shared/store/fork-thread.ts'
import { buildSideChatThread } from '@shared/threads/side-chat.ts'
import { createStore } from '@shared/store/store.ts'
import { createThread as createRendererThread } from '@shared/store/thread-helpers.ts'
import type { Thread } from '@shared/types/thread.ts'
import {
  clearThreadWorktree,
  createThread,
  getThreadMeta,
  loadThreadMessages,
  updateMeta,
} from '../services/thread-store.ts'
import { withoutMainOwnedThreadFields } from './thread-meta-guard.ts'

describe('withoutMainOwnedThreadFields', () => {
  it('drops a renderer-supplied remote-agent link and keeps everything else', () => {
    const forged = {
      title: 'Renamed',
      remoteAgentLink: { provider: 'cursor', agentId: 'bc-attacker', createdAt: 1 },
    }
    assert.deepEqual(withoutMainOwnedThreadFields(forged), { title: 'Renamed' })
  })

  it('drops an explicit undefined, so a stale renderer copy cannot erase the stored link', () => {
    const patch: Record<string, unknown> = { draft: 'x', remoteAgentLink: undefined }
    const guarded = withoutMainOwnedThreadFields(patch)
    assert.equal(Object.hasOwn(guarded, 'remoteAgentLink'), false)
    assert.deepEqual(guarded, { draft: 'x' })
  })

  it('leaves a payload without main-owned fields unchanged', () => {
    assert.deepEqual(withoutMainOwnedThreadFields({ a: 1, b: [2] }), { a: 1, b: [2] })
  })
})

describe('main-owned worktree metadata at the renderer boundary', () => {
  let root = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'copse-retired-meta-'))
    configureThreadStore({ workspaceRoot: () => root, listProjectIds: () => ['project'] })
  })
  afterEach(() => {
    configureThreadStore()
    rmSync(root, { recursive: true, force: true })
  })

  function originalThread(): Thread {
    return {
      id: 'thread',
      title: 'Finished run',
      status: 'idle',
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: 1,
      worktree: {
        path: join(root, 'checkout'),
        branch: 'copse/finished-run',
        baseBranch: 'main',
        baseCommit: 'a'.repeat(40),
        createdAt: 1,
        seededFromDirtyProject: false,
      },
    }
  }

  for (const stale of ['snapshot', 'undefined'] as const) {
    it(`preserves durable retirement through a renderer ${stale} while saving its title`, async () => {
      const original = originalThread()
      assert.ok(original.worktree)
      await createThread('project', original)
      await updateMeta('project', original.id, {
        worktree: { ...original.worktree, retiredAt: 123 },
      })
      const payload = {
        title: 'Edited after cleanup',
        worktree: stale === 'snapshot' ? original.worktree : undefined,
      }
      // This is the actual transform called by threads:update-meta, followed by
      // the real queued store writer; no alternate product flag or store path.
      await updateMeta('project', original.id, withoutMainOwnedThreadFields(payload))
      const current = await getThreadMeta('project', original.id)
      assert.equal(current?.worktree?.retiredAt, 123)
      assert.equal(current.title, 'Edited after cleanup')
    })
  }

  it('allows trusted main metadata replacement and explicit clearing', async () => {
    const original = originalThread()
    assert.ok(original.worktree)
    await createThread('project', original)
    await updateMeta('project', original.id, {
      worktree: { ...original.worktree, retiredAt: 123 },
    })
    const restored = { ...original.worktree, path: join(root, 'restored-checkout') }
    await updateMeta('project', original.id, { worktree: restored })
    assert.deepEqual((await getThreadMeta('project', original.id))?.worktree, restored)
    await updateMeta('project', original.id, {
      worktree: { ...restored, branch: 'copse/adopted-run' },
    })
    assert.equal(
      (await getThreadMeta('project', original.id))?.worktree?.branch,
      'copse/adopted-run',
    )
    assert.equal(await clearThreadWorktree('project', original.id), true)
    assert.equal((await getThreadMeta('project', original.id))?.worktree, undefined)
  })

  it('does not accept an owned checkout from a renderer create payload', async () => {
    const incoming = originalThread()
    incoming.messages = [
      { id: 'request', role: 'user', content: 'Keep my request', toolCalls: [], createdAt: 1 },
    ]
    const parsed = parseThreadValue(withoutMainOwnedThreadFields({ ...incoming }))
    assert.ok(parsed)
    assert.equal(parsed.worktree, undefined)
    await createThread('project', parsed)
    assert.equal((await getThreadMeta('project', parsed.id))?.title, incoming.title)
    assert.equal((await loadThreadMessages('project', parsed.id))[0]?.content, 'Keep my request')
  })

  it('preserves normal new-thread, fork and side-chat creates', async () => {
    const store = createStore({ threads: [] })
    createRendererThread(store)
    const blank = store.getState().threads[0]
    assert.ok(blank)
    const parent = originalThread()
    parent.messages = [
      {
        id: 'parent-request',
        role: 'user',
        content: 'Original context',
        toolCalls: [],
        createdAt: 1,
      },
    ]
    const fork = buildForkedThread(parent)
    const side = buildSideChatThread(parent, { anchorMessageId: 'parent-request' })
    assert.ok(fork)
    assert.ok(side)
    for (const incoming of [blank, fork, side]) {
      assert.equal(incoming.worktree, undefined)
      const parsed = parseThreadValue(withoutMainOwnedThreadFields({ ...incoming }))
      assert.ok(parsed)
      await createThread('project', parsed)
      assert.equal((await getThreadMeta('project', parsed.id))?.title, incoming.title)
      assert.equal((await getThreadMeta('project', parsed.id))?.worktree, undefined)
      assert.equal(
        (await loadThreadMessages('project', parsed.id)).length,
        incoming.messages.length,
      )
    }
  })
})
