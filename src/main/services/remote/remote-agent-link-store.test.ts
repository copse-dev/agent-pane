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
    storageSet('activeProjectId', 'proj-1')
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

    // findThreadForPrUrl resolves the active project (set in beforeEach).
    const hit = await findThreadForPrUrl('https://github.com/copse-dev/agent-pane/pull/99')
    assert.deepEqual(hit, {
      prUrl: 'https://github.com/copse-dev/agent-pane/pull/99',
      threadId: 't1',
      agentId: 'agent-1',
      provider: 'cursor',
    })
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
