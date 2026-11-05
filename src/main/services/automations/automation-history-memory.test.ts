import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureThreadStore } from '@copse/thread-store/environment.ts'
import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import type { Thread } from '@shared/types'
import {
  closeThreadStoreIndexes,
  createThread,
  getProjectThread,
  getThreadMeta,
  loadProjectThreads,
  saveProjectThread,
} from '../thread-store.ts'
import { createAutomationWorktreeReuse } from '../automation-worktree-reuse.ts'
import { storageSet } from '../storage/storage.ts'
import { TaskSupervisor } from '../supervisor/task-supervisor.ts'
import { FileSupervisedTaskStore } from '../supervisor/task-store.ts'
import { FileEventInboxStore } from '../supervisor/event-inbox-store.ts'
import { createAutomationService } from './automation-service.ts'
import {
  createBranchCiAutomationService,
  type BranchCiSnapshot,
} from './branch-ci-automation-service.ts'

const PROJECT = 'project'
const NOW = Date.parse('2026-09-29T10:05:00Z')
const SHA = 'a'.repeat(40)

function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function snapshot(id: number): BranchCiSnapshot {
  return {
    headSha: SHA,
    runs: [
      {
        id,
        run_attempt: 1,
        head_branch: 'main',
        head_sha: SHA,
        status: 'completed',
        conclusion: 'failure',
        updated_at: '2026-09-29T10:00:00Z',
        html_url: `https://github.com/owner/repo/actions/runs/${String(id)}`,
        name: 'CI',
      },
    ],
  }
}

describe('automation checks without project transcript allocation', () => {
  let root: string
  let transcriptBytes: number

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'copse-automation-history-'))
    transcriptBytes = 0
    configureThreadStore({
      workspaceRoot: () => root,
      perf: {
        count(name, _ms, bytes) {
          if (name === 'store:thread-prefetch') transcriptBytes += bytes ?? 0
        },
        span: (_name, fn) => fn(),
      },
    })
    storageSet(`plugin.${AUTOMATIONS_PLUGIN_ID}.storage`, [])
    storageSet(`plugin.${AUTOMATIONS_PLUGIN_ID}.ci-definitions`, [])
    await saveProjectThread(
      PROJECT,
      thread('unrelated', {
        messages: [
          {
            id: 'large-tool-result',
            role: 'assistant',
            content: 'Unrelated conversation',
            toolCalls: [
              {
                id: 'tool',
                name: 'read_file',
                args: {},
                status: 'done',
                result: 'x'.repeat(1024 * 1024),
              },
            ],
            createdAt: NOW,
          },
        ],
      }),
    )
    // Positive control: the old whole-project path really folds this transcript.
    await loadProjectThreads(PROJECT)
    assert.ok(transcriptBytes >= 1024 * 1024)
    transcriptBytes = 0
  })

  afterEach(() => {
    closeThreadStoreIndexes()
    configureThreadStore()
    rmSync(root, { recursive: true, force: true })
  })

  for (const status of ['running', 'pending-start'] as const) {
    it(`coalesces a ${status} scheduled run using the native metadata reader`, async () => {
      const service = createAutomationService({
        now: () => NOW,
        isPluginEnabled: () => true,
        createProjectThread: () => {
          throw new Error('A busy run must prevent creation')
        },
        releasePreviousRun: () => {
          throw new Error('A busy run must retain its checkout')
        },
        getActiveProjectId: () => PROJECT,
      })
      const schedule = await service.upsert(PROJECT, {
        name: 'Health check',
        cron: '* * * * *',
        prompt: 'Check the project.',
        model: 'test',
        enabled: true,
      })
      await saveProjectThread(
        PROJECT,
        thread('busy', {
          status: status === 'running' ? 'running' : 'idle',
          ...(status === 'pending-start' ? { draftPrompt: 'Check the project.' } : {}),
          automation: { scheduleId: schedule.id, scheduleName: schedule.name, triggeredAt: NOW },
          // A checkout to retain: without one, cleanup skips the run and the
          // releasePreviousRun guard above could never fire.
          worktree: {
            path: '/worktrees/busy',
            branch: 'copse/busy',
            baseBranch: 'main',
            baseCommit: SHA,
            createdAt: NOW - 1,
            seededFromDirtyProject: false,
          },
        }),
      )
      await service.tick()
      assert.equal((await service.runNow(PROJECT, schedule.id)).disposition, 'coalesced')
      assert.deepEqual((await service.cleanupRuns(PROJECT, schedule.id)).released, [])
      assert.equal(
        (await getThreadMeta(PROJECT, 'busy'))?.status,
        status === 'running' ? 'running' : 'idle',
      )
      assert.equal(transcriptBytes, 0, 'admission and cleanup must not hydrate unrelated chats')
    })
  }

  it('selects and hands over a retained checkout without hydrating either run or unrelated history', async () => {
    const checkout = {
      path: '/worktrees/previous',
      branch: 'copse/previous',
      baseBranch: 'main',
      baseCommit: SHA,
      createdAt: NOW - 1,
      seededFromDirtyProject: false,
    }
    for (const id of ['previous', 'next']) {
      await saveProjectThread(
        PROJECT,
        thread(id, {
          createdAt: id === 'previous' ? NOW - 1 : NOW,
          automation: { scheduleId: 'schedule', scheduleName: 'Health check', triggeredAt: NOW },
          ...(id === 'previous' ? { worktree: checkout } : {}),
          messages: [
            {
              id: `message-${id}`,
              role: 'user',
              content: 'Prior request',
              toolCalls: [],
              createdAt: NOW,
            },
          ],
        }),
      )
    }
    const disposed: string[] = []
    const reuse = createAutomationWorktreeReuse({
      projectRoot: () => '/repo',
      isLive: () => false,
      disposeSession: (id) => {
        disposed.push(id)
        return Promise.resolve()
      },
      canAdopt: () => Promise.resolve(true),
      adopt: () =>
        Promise.resolve({
          status: 'adopted',
          previousHead: SHA,
          worktree: { ...checkout, path: '/worktrees/next' },
        }),
      updateMeta: async (projectId, id, patch) => {
        assert.equal(projectId, PROJECT)
        assert.equal(id, 'previous')
        assert.equal(patch.worktree?.retiredAt, NOW)
      },
      now: () => NOW,
    })
    assert.equal(await reuse.canReusePreviousRun(PROJECT, 'previous'), true)
    const result = await reuse.reuseFor({
      projectId: PROJECT,
      threadId: 'next',
      projectRoot: '/repo',
      baseBranch: 'main',
    })
    assert.equal(result?.path, '/worktrees/next')
    assert.deepEqual(disposed, ['previous'])
    assert.equal(transcriptBytes, 0, 'checkout reuse must not fold any transcript')
  })

  it('admits a new CI failure and blocks a later poll on its pending run without reading history', async () => {
    const env = { COPSE_WORKSPACE_DIR: root }
    const supervisor = new TaskSupervisor({ store: new FileSupervisedTaskStore(env) })
    let current = snapshot(1)
    let created = 0
    const service = createBranchCiAutomationService({
      now: () => NOW,
      isPluginEnabled: () => true,
      repositoryForProject: () => Promise.resolve('github.com/owner/repo'),
      snapshot: () => Promise.resolve(current),
      getProjectThread,
      createProjectThread: async (projectId, run) => {
        created++
        await createThread(projectId, run)
      },
      releasePreviousRun: () => Promise.resolve({ released: true }),
      supervisor: () => supervisor,
      inboxStore: new FileEventInboxStore(env),
    })
    try {
      await service.upsert(PROJECT, {
        name: 'CI check',
        branch: 'main',
        prompt: 'Investigate CI.',
        model: 'test',
        enabled: true,
      })
      current = snapshot(2)
      await service.poll()
      await supervisor.waitForIdle()
      assert.equal(created, 1)
      current = snapshot(3)
      await service.poll()
      await supervisor.waitForIdle()
      assert.equal(created, 1, 'the pending draft must still block another run')
      assert.equal(
        transcriptBytes,
        0,
        'polling and inbox authorization must not fold project history',
      )
    } finally {
      service.stop()
      await supervisor.shutdown()
    }
  })
})
