import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Thread } from '@shared/types'
import { storageSet } from '../services/storage/storage.ts'
import { createThread } from '../services/thread-store.ts'
import {
  attachRemoteAgentPrFromText,
  recordRemoteAgentLaunch,
} from '../services/remote/remote-agent-link-store.ts'
import { senderProjectPrReaders } from './gh-handlers.ts'

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

/** Two windows on two projects, plus one (a fresh window) showing none. */
const WINDOW_PROJECTS: Readonly<Record<string, string | null>> = {
  'window-a': 'proj-a',
  'window-b': 'proj-b',
  'window-empty': null,
}

describe('senderProjectPrReaders', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-gh-readers-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
    // The process-global active project is a third one: no reader may use it.
    storageSet('activeProjectId', 'proj-global')
  })

  afterEach(() => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    storageSet('activeProjectId', null)
    rmSync(root, { recursive: true, force: true })
  })

  it("answers each window from its own project, never the process-global one's", async () => {
    for (const [projectId, threadId, n] of [
      ['proj-a', 'ta', 1],
      ['proj-b', 'tb', 2],
      ['proj-global', 'tg', 3],
    ] as const) {
      await createThread(projectId, thread(threadId))
      await recordRemoteAgentLaunch({
        projectId,
        threadId,
        provider: 'cursor',
        agentId: `agent-${threadId}`,
        createdAt: n,
      })
      await attachRemoteAgentPrFromText(
        projectId,
        threadId,
        `PR: https://github.com/copse-dev/agent-pane/pull/${String(n)}`,
      )
    }
    const readers = senderProjectPrReaders((sender: string) => WINDOW_PROJECTS[sender] ?? null)

    const [a, b, empty] = await Promise.all([
      readers.agentPrLinks('window-a'),
      readers.agentPrLinks('window-b'),
      readers.agentPrLinks('window-empty'),
    ])
    assert.deepEqual(
      a.map((link) => link.threadId),
      ['ta'],
    )
    assert.deepEqual(
      b.map((link) => link.threadId),
      ['tb'],
    )
    assert.deepEqual(empty, [])

    const pr = {
      owner: 'copse-dev',
      repo: 'agent-pane',
      number: 3,
      url: 'https://github.com/copse-dev/agent-pane/pull/3',
    }
    assert.deepEqual(await readers.prThreadRelationships('window-empty', pr), [])
    assert.deepEqual(await readers.threadPrRelationships('window-empty', 'tg'), [])
  })
})
