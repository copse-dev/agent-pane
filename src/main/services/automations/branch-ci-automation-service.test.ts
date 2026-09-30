import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import type { Thread } from '@shared/types'
import { storageSet } from '../storage/storage.ts'
import { TaskSupervisor } from '../supervisor/task-supervisor.ts'
import { FileSupervisedTaskStore } from '../supervisor/task-store.ts'
import { FileEventInboxStore } from '../supervisor/event-inbox-store.ts'
import {
  createBranchCiAutomationService,
  type BranchCiRun,
  type BranchCiSnapshot,
} from './branch-ci-automation-service.ts'

const STORAGE_KEY = `plugin.${AUTOMATIONS_PLUGIN_ID}.ci-definitions`
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

function run(
  id: number,
  headSha: string,
  status = 'completed',
  conclusion: string | null = 'failure',
): BranchCiRun {
  return {
    id,
    run_attempt: 1,
    head_branch: 'main',
    head_sha: headSha,
    status,
    conclusion,
    updated_at: '2026-09-29T10:00:00Z',
    html_url: `https://github.com/owner/repo/actions/runs/${String(id)}`,
    name: 'CI',
  }
}

describe('branch CI automations', () => {
  it('baselines existing failures, admits one new failure, and suppresses repeat polls and stale heads', async (t) => {
    storageSet(STORAGE_KEY, [])
    const root = await mkdtemp(join(tmpdir(), 'copse-branch-ci-'))
    const env = { COPSE_WORKSPACE_DIR: root }
    const supervisor = new TaskSupervisor({ store: new FileSupervisedTaskStore(env) })
    const threads = new Map<string, Thread>()
    let snapshot: BranchCiSnapshot = { headSha: SHA_A, runs: [run(1, SHA_A)] }
    let reads = 0
    const service = createBranchCiAutomationService({
      now: () => Date.parse('2026-09-29T10:05:00Z'),
      isPluginEnabled: () => true,
      repositoryForProject: () => Promise.resolve('github.com/owner/repo'),
      snapshot: () => {
        reads++
        return Promise.resolve(snapshot)
      },
      loadProjectThreads: () => Promise.resolve([...threads.values()]),
      getProjectThread: (_projectId, threadId) => Promise.resolve(threads.get(threadId) ?? null),
      createProjectThread: (_projectId, thread) => {
        threads.set(thread.id, thread)
        return Promise.resolve()
      },
      releasePreviousRun: () => Promise.resolve(true),
      supervisor: () => supervisor,
      inboxStore: new FileEventInboxStore(env),
    })
    t.after(async () => {
      service.stop()
      await supervisor.shutdown()
      await rm(root, { recursive: true, force: true })
    })

    const definition = await service.upsert('project-a', {
      name: 'Investigate CI',
      branch: 'main',
      prompt: 'Investigate the failure.',
      model: 'gpt-test',
      enabled: true,
    })
    assert.equal(definition.trigger.repository, 'github.com/owner/repo')
    assert.deepEqual(definition.seenDeliveries, ['1:1'])
    await service.poll()
    assert.equal(threads.size, 0)

    snapshot = { headSha: SHA_A, runs: [run(2, SHA_A), run(1, SHA_A)] }
    await service.poll()
    await supervisor.waitForIdle()
    assert.equal(threads.size, 1)
    const created = [...threads.values()][0]
    assert.ok(created)
    assert.match(created.draftPrompt ?? '', /Investigate the failure/)
    assert.match(created.draftPrompt ?? '', /"runId": 2/)
    assert.equal(created.automation?.scheduleId, definition.id)
    assert.deepEqual(await service.canStart('project-a', created.id), { allowed: true })
    await service.poll()
    assert.equal(threads.size, 1)

    snapshot = { headSha: SHA_B, runs: [run(3, SHA_A), run(2, SHA_A)] }
    await service.poll()
    assert.equal(threads.size, 1)
    assert.deepEqual(await service.canStart('project-a', created.id), {
      allowed: false,
      reason: 'A newer branch head superseded this failed CI run.',
    })
    await service.upsert('project-a', {
      id: definition.id,
      name: definition.name,
      branch: 'main',
      prompt: definition.prompt,
      model: definition.model,
      enabled: false,
    })
    assert.deepEqual(await service.canStart('project-a', created.id), {
      allowed: false,
      reason: 'The CI automation was paused or changed before this task started.',
    })
    assert.ok(reads >= 4)
  })

  it('does not mark an in-progress run seen before its failed transition', async (t) => {
    storageSet(STORAGE_KEY, [])
    const root = await mkdtemp(join(tmpdir(), 'copse-branch-ci-'))
    const env = { COPSE_WORKSPACE_DIR: root }
    const supervisor = new TaskSupervisor({ store: new FileSupervisedTaskStore(env) })
    const threads: Thread[] = []
    let snapshot: BranchCiSnapshot = { headSha: SHA_A, runs: [run(5, SHA_A, 'in_progress', null)] }
    const service = createBranchCiAutomationService({
      now: () => 1_000,
      isPluginEnabled: () => true,
      repositoryForProject: () => Promise.resolve('github.com/owner/repo'),
      snapshot: () => Promise.resolve(snapshot),
      loadProjectThreads: () => Promise.resolve(threads),
      getProjectThread: () => Promise.resolve(null),
      createProjectThread: (_projectId, thread) => {
        threads.push(thread)
        return Promise.resolve()
      },
      releasePreviousRun: () => Promise.resolve(true),
      supervisor: () => supervisor,
      inboxStore: new FileEventInboxStore(env),
    })
    t.after(async () => {
      service.stop()
      await supervisor.shutdown()
      await rm(root, { recursive: true, force: true })
    })
    await service.upsert('project-a', {
      name: 'CI',
      branch: 'main',
      prompt: 'Investigate',
      model: 'gpt-test',
      enabled: true,
    })
    snapshot = { headSha: SHA_A, runs: [run(5, SHA_A)] }
    await service.poll()
    await supervisor.waitForIdle()
    assert.equal(threads.length, 1)
  })
})
