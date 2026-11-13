import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Thread } from '@shared/types'
import { storageSet } from '../storage/storage.ts'
import { createThread, getThreadMeta } from '../thread-store.ts'
import {
  attachRemoteAgentPrFromText,
  findThreadForPrUrl,
  listProjectAgentPrLinks,
  recordRemoteAgentLaunch,
} from './remote-agent-link-store.ts'

function thread(id: string): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('remote-agent-link-store', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-link-store-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
    // The window shows a third project: no lookup here may read it (#3958).
    storageSet('activeProjectId', 'proj-window')
  })

  afterEach(() => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    storageSet('activeProjectId', null)
    rmSync(root, { recursive: true, force: true })
  })

  it('records a launch link then attaches the PR scraped from the reply', async () => {
    await createThread('proj-1', thread('t1'))
    await recordRemoteAgentLaunch({
      projectId: 'proj-1',
      threadId: 't1',
      provider: 'cursor',
      agentId: 'agent-1',
      runId: 'run-1',
      createdAt: 42,
    })

    const afterLaunch = await getThreadMeta('proj-1', 't1')
    assert.ok(afterLaunch)
    const launched = afterLaunch.remoteAgentLink
    assert.ok(launched)
    assert.equal(launched.provider, 'cursor')
    assert.equal(launched.agentId, 'agent-1')
    assert.equal(launched.runId, 'run-1')
    assert.equal(launched.createdAt, 42)
    assert.equal(launched.prUrl, undefined)
    assert.deepEqual(afterLaunch.cursorAgentIds, ['agent-1'])

    await attachRemoteAgentPrFromText(
      'proj-1',
      't1',
      'Opened the PR: https://github.com/copse-dev/agent-pane/pull/99 — take a look.',
    )
    const afterPr = await getThreadMeta('proj-1', 't1')
    assert.ok(afterPr)
    const linked = afterPr.remoteAgentLink
    assert.ok(linked)
    assert.equal(linked.prUrl, 'https://github.com/copse-dev/agent-pane/pull/99')

    const hit = await findThreadForPrUrl(
      'proj-1',
      'https://github.com/copse-dev/agent-pane/pull/99',
    )
    assert.deepEqual(hit, {
      prUrl: 'https://github.com/copse-dev/agent-pane/pull/99',
      threadId: 't1',
      agentId: 'agent-1',
      provider: 'cursor',
    })
  })

  it("retains only this thread's recent Cursor launches after a session replacement", async () => {
    await createThread('proj-1', thread('t1'))
    await createThread('proj-1', thread('t2'))
    for (let i = 0; i < 130; i++) {
      await recordRemoteAgentLaunch({
        projectId: 'proj-1',
        threadId: 't1',
        provider: 'cursor',
        agentId: `agent-${String(i)}`,
        createdAt: i + 1,
      })
    }
    await recordRemoteAgentLaunch({
      projectId: 'proj-1',
      threadId: 't2',
      provider: 'cursor',
      agentId: 'other-thread-agent',
      createdAt: 1,
    })
    const beforeSwitch = await getThreadMeta('proj-1', 't1')
    assert.equal(beforeSwitch?.cursorAgentIds?.length, 128)
    assert.equal(beforeSwitch.cursorAgentIds[0], 'agent-2')
    assert.equal(beforeSwitch.cursorAgentIds.at(-1), 'agent-129')
    await recordRemoteAgentLaunch({
      projectId: 'proj-1',
      threadId: 't1',
      provider: 'cursor',
      agentId: 'agent-2',
      createdAt: 130,
    })
    const afterReuse = await getThreadMeta('proj-1', 't1')
    assert.equal(afterReuse?.cursorAgentIds?.length, 128)
    assert.equal(afterReuse.cursorAgentIds[0], 'agent-3')
    assert.equal(afterReuse.cursorAgentIds.at(-1), 'agent-2')
    await recordRemoteAgentLaunch({
      projectId: 'proj-1',
      threadId: 't1',
      provider: 'openai',
      agentId: 'openai-run',
      createdAt: 131,
    })
    const switched = await getThreadMeta('proj-1', 't1')
    assert.equal(switched?.remoteAgentLink?.provider, 'openai')
    assert.deepEqual(switched.cursorAgentIds, afterReuse.cursorAgentIds)
    assert.deepEqual((await getThreadMeta('proj-1', 't2'))?.cursorAgentIds, ['other-thread-agent'])
  })

  it("lists and finds each project's links in that project, never the window's", async () => {
    const pr = (n: number): string => `https://github.com/copse-dev/agent-pane/pull/${String(n)}`
    for (const [projectId, threadId, n] of [
      ['proj-a', 'ta', 1],
      ['proj-b', 'tb', 2],
      ['proj-window', 'tw', 3],
    ] as const) {
      await createThread(projectId, thread(threadId))
      await recordRemoteAgentLaunch({
        projectId,
        threadId,
        provider: 'cursor',
        agentId: `agent-${threadId}`,
        createdAt: n,
      })
      await attachRemoteAgentPrFromText(projectId, threadId, `PR: ${pr(n)}`)
    }

    const [linksA, linksB] = await Promise.all([
      listProjectAgentPrLinks('proj-a'),
      listProjectAgentPrLinks('proj-b'),
    ])
    assert.deepEqual(
      linksA.map((link) => link.threadId),
      ['ta'],
    )
    assert.deepEqual(
      linksB.map((link) => link.threadId),
      ['tb'],
    )
    assert.equal((await findThreadForPrUrl('proj-a', pr(1)))?.threadId, 'ta')
    assert.equal(await findThreadForPrUrl('proj-a', pr(2)), null)
    assert.equal(await findThreadForPrUrl('proj-b', pr(3)), null)
  })

  it('attach is a no-op when the reply carries no PR URL', async () => {
    await createThread('proj-1', thread('t1'))
    await recordRemoteAgentLaunch({
      projectId: 'proj-1',
      threadId: 't1',
      provider: 'anthropic',
      agentId: 'a',
      createdAt: 1,
    })
    await attachRemoteAgentPrFromText('proj-1', 't1', 'no links here, just prose')
    const meta = await getThreadMeta('proj-1', 't1')
    assert.ok(meta)
    const link = meta.remoteAgentLink
    assert.ok(link)
    assert.equal(link.prUrl, undefined)
  })

  it('does nothing when the launching project is null', async () => {
    await createThread('proj-1', thread('t1'))
    await recordRemoteAgentLaunch({
      projectId: null,
      threadId: 't1',
      provider: 'cursor',
      agentId: 'a',
      createdAt: 1,
    })
    const meta = await getThreadMeta('proj-1', 't1')
    assert.ok(meta)
    assert.equal(meta.remoteAgentLink, undefined)
  })
})
