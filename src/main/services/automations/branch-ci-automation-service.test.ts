import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import type { Thread } from '@shared/types'
import { storageGet, storageSet } from '../storage/storage.ts'
import { TaskSupervisor } from '../supervisor/task-supervisor.ts'
import { FileSupervisedTaskStore } from '../supervisor/task-store.ts'
import { FileEventInboxStore } from '../supervisor/event-inbox-store.ts'
import { COMMAND_OUTPUT_MAX_BYTES, truncateCommandOutput } from '../exec/subprocess-output-cap.ts'
import {
  createBranchCiAutomationService,
  readBranchCiSnapshot,
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

describe('branch CI snapshots', () => {
  it('encodes branch names, preserves the GitHub host, and accepts an empty result', async () => {
    const calls: string[][] = []
    const snapshot = await readBranchCiSnapshot(
      '/workspace',
      'github.example.com/owner/repo',
      'release/stable',
      (args) => {
        calls.push(args)
        assert.deepEqual(args.slice(2, 4), ['--hostname', 'github.example.com'])
        return Promise.resolve({
          stdout:
            calls.length === 1
              ? JSON.stringify({ commit: { sha: SHA_B } })
              : JSON.stringify({ workflow_runs: [] }),
          stderr: '',
          code: 0,
        })
      },
    )
    assert.equal(calls[0]?.[1], 'repos/owner/repo/branches/release%2Fstable')
    assert.equal(
      calls[1]?.[1],
      `repos/owner/repo/actions/runs?branch=release%2Fstable&head_sha=${SHA_B}&per_page=100`,
    )
    assert.deepEqual(snapshot, { headSha: SHA_B, runs: [] })
  })

  it('does not request workflow runs when the branch head is invalid or unavailable', async () => {
    for (const response of [
      { stdout: '{"commit":{"sha":"invalid"}}', stderr: '', code: 0 },
      { stdout: '', stderr: 'GitHub is unavailable', code: 1 },
    ]) {
      let calls = 0
      await assert.rejects(
        readBranchCiSnapshot('/workspace', 'github.com/owner/repo', 'main', () => {
          calls++
          return Promise.resolve(response)
        }),
        /GitHub returned invalid CI data|GitHub is unavailable/,
      )
      assert.equal(calls, 1)
    }
  })

  it('still rejects malformed, oversized, and failed workflow responses', async () => {
    for (const response of [
      { stdout: '{"workflow_runs":', stderr: '', code: 0 },
      { stdout: '{"workflow_runs":[{"id":1}]}', stderr: '', code: 0 },
      {
        stdout: JSON.stringify({
          workflow_runs: Array.from({ length: 101 }, (_, index) => run(index + 1, SHA_A)),
        }),
        stderr: '',
        code: 0,
      },
      { stdout: '', stderr: 'GitHub is unavailable', code: 1 },
    ]) {
      let calls = 0
      await assert.rejects(
        readBranchCiSnapshot('/workspace', 'github.com/owner/repo', 'main', () => {
          calls++
          return Promise.resolve(
            calls === 1
              ? { stdout: JSON.stringify({ commit: { sha: SHA_A } }), stderr: '', code: 0 }
              : response,
          )
        }),
        /GitHub returned invalid CI data|GitHub is unavailable/,
      )
      assert.equal(calls, 2)
    }
  })
})

describe('branch CI automations', () => {
  it('previews and saves a full page of compact current-head runs, then admits an older run rerun today', async (t) => {
    storageSet(STORAGE_KEY, [])
    const root = await mkdtemp(join(tmpdir(), 'copse-branch-ci-'))
    const env = { COPSE_WORKSPACE_DIR: root }
    const supervisor = new TaskSupervisor({ store: new FileSupervisedTaskStore(env) })
    const threads: Thread[] = []
    const runs = Array.from({ length: 100 }, (_, index) => run(index + 1, SHA_A))
    const fullResponse = JSON.stringify({
      workflow_runs: runs.map((entry) => ({
        ...entry,
        created_at: '2026-09-01T10:00:00Z',
        head_commit: { message: 'x'.repeat(16_000) },
      })),
    })
    assert.ok(Buffer.byteLength(fullResponse) > COMMAND_OUTPUT_MAX_BYTES)
    assert.ok(Buffer.byteLength(JSON.stringify({ workflow_runs: runs })) < COMMAND_OUTPUT_MAX_BYTES)
    let headReads = 0
    let runReads = 0
    const service = createBranchCiAutomationService({
      now: () => Date.parse('2026-10-01T10:05:00Z'),
      isPluginEnabled: () => true,
      repositoryForProject: () => Promise.resolve('github.com/owner/repo'),
      snapshot: (definition) =>
        readBranchCiSnapshot(
          root,
          definition.trigger.repository,
          definition.trigger.branch,
          (args, options) => {
            assert.deepEqual(options, { cwd: root, timeout_ms: 15_000 })
            if (args[1] === 'repos/owner/repo/branches/main') {
              headReads++
              assert.deepEqual(args.slice(2), [
                '--hostname',
                'github.com',
                '--jq',
                '{commit: {sha: .commit.sha}}',
              ])
              return Promise.resolve({
                stdout: JSON.stringify({ commit: { sha: SHA_A } }),
                stderr: '',
                code: 0,
              })
            }
            runReads++
            assert.equal(headReads, runReads, 'read the head before querying runs')
            assert.deepEqual(args, [
              'api',
              `repos/owner/repo/actions/runs?branch=main&head_sha=${SHA_A}&per_page=100`,
              '--hostname',
              'github.com',
              '--jq',
              '{workflow_runs: [.workflow_runs[] | {id, run_attempt, head_branch, head_sha, status, conclusion, updated_at, html_url, name}]}',
            ])
            // The gh boundary emits only the requested fields, then the normal
            // subprocess cap applies before the real decoder sees the response.
            return Promise.resolve({
              stdout: truncateCommandOutput(JSON.stringify({ workflow_runs: runs })),
              stderr: '',
              code: 0,
            })
          },
        ),
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

    assert.deepEqual(await service.testMatch('project-a', { branch: 'main' }), {
      repository: 'github.com/owner/repo',
      branch: 'main',
      latestFailure: 'https://github.com/owner/repo/actions/runs/1',
    })
    const definition = await service.upsert('project-a', {
      name: 'Investigate CI',
      branch: 'main',
      prompt: 'Investigate the failure.',
      model: 'gpt-test',
      enabled: true,
    })
    assert.equal(service.list('project-a')[0]?.id, definition.id)
    assert.equal(definition.seenDeliveries.length, 100)
    await service.poll()
    assert.equal(threads.length, 0)

    runs[0] = { ...run(1, SHA_A), run_attempt: 2, updated_at: '2026-10-01T10:00:00Z' }
    await service.poll()
    await supervisor.waitForIdle()
    assert.equal(threads.length, 1)
    assert.match(threads[0]?.draftPrompt ?? '', /"attempt": 2/)
    await service.poll()
    assert.equal(threads.length, 1)
  })

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
  it('keeps a CI failure that hit the live worktree limit, and handles it once the worktree is released', async (t) => {
    storageSet(STORAGE_KEY, [])
    const root = await mkdtemp(join(tmpdir(), 'copse-branch-ci-'))
    const env = { COPSE_WORKSPACE_DIR: root }
    const supervisor = new TaskSupervisor({ store: new FileSupervisedTaskStore(env) })
    const threads = new Map<string, Thread>()
    let snapshot: BranchCiSnapshot = { headSha: SHA_A, runs: [run(1, SHA_A)] }
    let worktreeReleased = false
    const service = createBranchCiAutomationService({
      now: () => Date.parse('2026-09-29T10:05:00Z'),
      isPluginEnabled: () => true,
      repositoryForProject: () => Promise.resolve('github.com/owner/repo'),
      snapshot: () => Promise.resolve(snapshot),
      loadProjectThreads: () => Promise.resolve([...threads.values()]),
      getProjectThread: (_projectId, threadId) => Promise.resolve(threads.get(threadId) ?? null),
      createProjectThread: (_projectId, thread) => {
        threads.set(thread.id, thread)
        return Promise.resolve()
      },
      releasePreviousRun: () => Promise.resolve(worktreeReleased),
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
    // An earlier, finished run still holds the schedule's only live worktree.
    threads.set('earlier', {
      id: 'earlier',
      title: 'Investigate CI',
      status: 'idle',
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'gpt-test',
      automation: { scheduleId: definition.id, scheduleName: definition.name, triggeredAt: 1 },
      worktree: {
        path: '/worktrees/earlier',
        branch: 'codex/earlier',
        baseBranch: 'main',
        baseCommit: 'a'.repeat(40),
        createdAt: 1,
        seededFromDirtyProject: false,
      },
      createdAt: 1,
      updatedAt: 1,
    })

    snapshot = { headSha: SHA_A, runs: [run(2, SHA_A), run(1, SHA_A)] }
    await service.poll()
    await supervisor.waitForIdle()
    assert.equal(threads.size, 1, 'no run starts while the worktree is held')

    worktreeReleased = true
    await service.poll()
    await supervisor.waitForIdle()
    assert.equal(threads.size, 2, 'the held-back failure is handled once there is room')
    const created = [...threads.values()].find((thread) => thread.id !== 'earlier')
    assert.match(created?.draftPrompt ?? '', /"runId": 2/)
  })
  it('keeps working definitions usable and editable when one stored row is damaged', async (t) => {
    storageSet(STORAGE_KEY, [])
    const root = await mkdtemp(join(tmpdir(), 'copse-branch-ci-'))
    const env = { COPSE_WORKSPACE_DIR: root }
    const supervisor = new TaskSupervisor({ store: new FileSupervisedTaskStore(env) })
    const service = createBranchCiAutomationService({
      now: () => 1_000,
      isPluginEnabled: () => true,
      repositoryForProject: () => Promise.resolve('github.com/owner/repo'),
      snapshot: () => Promise.resolve({ headSha: SHA_A, runs: [run(1, SHA_A)] }),
      loadProjectThreads: () => Promise.resolve([]),
      getProjectThread: () => Promise.resolve(null),
      createProjectThread: () => Promise.resolve(),
      releasePreviousRun: () => Promise.resolve(true),
      supervisor: () => supervisor,
      inboxStore: new FileEventInboxStore(env),
    })
    t.after(async () => {
      service.stop()
      await supervisor.shutdown()
      await rm(root, { recursive: true, force: true })
    })
    const good = await service.upsert('project-a', {
      name: 'Good',
      branch: 'main',
      prompt: 'Investigate',
      model: 'gpt-test',
      enabled: true,
    })
    const damaged = { id: 'damaged', trigger: 'not-an-object' }
    const saved = storageGet(STORAGE_KEY)
    const rows: unknown[] = Array.isArray(saved) ? saved : []
    storageSet(STORAGE_KEY, [damaged, ...rows])

    assert.deepEqual(
      service.list('project-a').map((item) => item.id),
      [good.id],
    )
    await service.upsert('project-a', {
      id: good.id,
      name: 'Good, renamed',
      branch: 'main',
      prompt: 'Investigate',
      model: 'gpt-test',
      enabled: true,
    })
    const second = await service.upsert('project-a', {
      name: 'Second',
      branch: 'main',
      prompt: 'Investigate',
      model: 'gpt-test',
      enabled: false,
    })
    await service.remove('project-a', second.id)

    const stored = storageGet(STORAGE_KEY)
    assert.ok(Array.isArray(stored))
    assert.ok(stored.some((row) => JSON.stringify(row) === JSON.stringify(damaged)))
    assert.deepEqual(
      service.list('project-a').map((item) => item.name),
      ['Good, renamed'],
    )
  })
})
