import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureThreadStore } from '@copse/thread-store/environment.ts'
import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import type { AutomationTriggerEvent, Thread } from '@shared/types'
import {
  closeThreadStoreIndexes,
  createThread,
  getProjectThread,
  getThreadMeta,
  loadProjectThreadMetas,
  saveProjectThread,
  updateMetaOrThrow,
} from '../thread-store.ts'
import { storageSet } from '../storage/storage.ts'
import { FileSupervisedTaskStore } from '../supervisor/task-store.ts'
import { TaskSupervisor } from '../supervisor/task-supervisor.ts'
import { FileEventInboxStore } from '../supervisor/event-inbox-store.ts'
import { createAutomationService } from './automation-service.ts'
import {
  createBranchCiAutomationService,
  type BranchCiSnapshot,
} from './branch-ci-automation-service.ts'

const PROJECT = 'closed-project'
const NOW = Date.parse('2026-11-06T10:05:00Z')

describe('interrupted automations in a project that stays closed', () => {
  let root: string
  let supervisor: TaskSupervisor
  let services: ReturnType<typeof createAutomationService>[]
  let eventServices: ReturnType<typeof createBranchCiAutomationService>[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-interrupted-automation-'))
    configureThreadStore({ workspaceRoot: () => join(root, 'workspace') })
    storageSet(`plugin.${AUTOMATIONS_PLUGIN_ID}.storage`, [])
    supervisor = new TaskSupervisor({
      store: new FileSupervisedTaskStore({ COPSE_WORKSPACE_DIR: join(root, 'workspace') }),
      clock: { now: (): number => NOW, setTimeout: (): number => 0, clearTimeout: (): void => {} },
      cronEnabled: (): boolean => true,
      onError: (): void => {},
    })
    services = []
    eventServices = []
    storageSet(`plugin.${AUTOMATIONS_PLUGIN_ID}.ci-definitions`, [])
  })

  afterEach(async () => {
    for (const service of services) service.stop()
    for (const service of eventServices) service.stop()
    await supervisor.shutdown()
    closeThreadStoreIndexes()
    configureThreadStore()
    await rm(root, { recursive: true, force: true })
  })

  async function boot(
    isActive?: () => boolean | null,
    afterRead?: () => Promise<void>,
  ): Promise<{
    service: ReturnType<typeof createAutomationService>
    events: AutomationTriggerEvent[]
    dispatches: string[]
    settled(threadId: string): Promise<void>
  }> {
    const events: AutomationTriggerEvent[] = []
    const dispatches: string[] = []
    const settlements = new Map<string, () => void>()
    const service = createAutomationService({
      now: () => NOW,
      isPluginEnabled: () => true,
      createProjectThread: createThread,
      ...(afterRead
        ? {
            loadProjectThreadMetas: async (projectId: string): Promise<Thread[]> => {
              const threads = await loadProjectThreadMetas(projectId)
              await afterRead()
              return threads
            },
          }
        : {}),
      releasePreviousRun: async () => ({
        released: false,
        reason: 'uncommitted-changes',
        paths: ['checkpoint.txt'],
      }),
      prepareCheckout: async () => ({
        checkoutMode: 'worktree',
        choice: 'worktree',
        branch: 'copse/test',
      }),
      supervisor: () => supervisor,
    })
    services.push(service)
    service.start(
      (event) => {
        events.push(event)
        if (event.headlessSettled) settlements.get(event.threadId)?.()
      },
      async (request, host) => {
        dispatches.push(request.threadId)
        host.emit(request.threadId, { type: 'done' })
      },
      () => 'a-different-project',
      isActive,
    )
    await service.sync()
    return {
      service,
      events,
      dispatches,
      async settled(threadId): Promise<void> {
        if (events.some((event) => event.threadId === threadId && event.headlessSettled)) return
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('Headless fixture did not settle'))
          }, 5000)
          settlements.set(threadId, () => {
            clearTimeout(timer)
            resolve()
          })
        })
      },
    }
  }

  async function interrupted(limit: number | 'unlimited'): Promise<{
    scheduleId: string
    old: Thread
    evidence: Map<string, Buffer>
  }> {
    const first = await boot()
    const schedule = await first.service.upsert(PROJECT, {
      name: 'Keep project healthy',
      cron: '* * * * *',
      prompt: 'Check the project and preserve the existing checkpoint.',
      model: 'test-provider',
      enabled: true,
      maxLiveWorktrees: limit,
    })
    const checkout = join(root, 'retained-checkout')
    await mkdir(checkout)
    await writeFile(join(checkout, 'checkpoint.txt'), 'work before the interruption\n')
    const old: Thread = {
      id: 'interrupted-run',
      title: schedule.name,
      status: 'running',
      usage: { inputTokens: 0, outputTokens: 0 },
      automation: {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        triggeredAt: NOW - 60_000,
      },
      currentEpoch: 'original-human-tree',
      continuationUsed: 5,
      messages: [
        {
          id: 'original-request',
          role: 'user',
          content: 'Check the project.',
          toolCalls: [],
          createdAt: NOW - 60_000,
        },
        {
          id: 'partial-result',
          role: 'assistant',
          content: 'The first checkpoint is saved.',
          toolCalls: [],
          createdAt: NOW - 59_000,
        },
      ],
      worktree: {
        path: checkout,
        branch: 'copse/interrupted-run',
        baseBranch: 'main',
        baseCommit: 'a'.repeat(40),
        createdAt: NOW - 60_000,
        seededFromDirtyProject: false,
      },
      createdAt: NOW - 60_000,
      updatedAt: NOW - 59_000,
    }
    await saveProjectThread(PROJECT, old)
    assert.equal((await getThreadMeta(PROJECT, old.id))?.status, 'running')
    first.service.stop()
    closeThreadStoreIndexes()
    const paths = [
      join(root, 'workspace', PROJECT, old.id, 'events.jsonl'),
      join(root, 'workspace', PROJECT, old.id, 'messages', 'partial-result.md'),
      join(checkout, 'checkpoint.txt'),
    ]
    const evidence = new Map<string, Buffer>()
    for (const path of paths) evidence.set(path, await readFile(path))
    return { scheduleId: schedule.id, old, evidence }
  }

  async function preserved(evidence: Map<string, Buffer>): Promise<void> {
    for (const [path, contents] of evidence) assert.deepEqual(await readFile(path), contents)
  }

  it('starts only a new run after a cold restart proves the former run absent', async () => {
    const { scheduleId, old, evidence } = await interrupted('unlimited')
    const restarted = await boot(() => false)

    const event = await restarted.service.runNow(PROJECT, scheduleId)

    await preserved(evidence)
    assert.equal(
      event.disposition,
      'started',
      'a dead persisted running flag must not coalesce forever',
    )
    assert.notEqual(event.threadId, old.id)
    await restarted.settled(event.threadId)
    const recovered = await getThreadMeta(PROJECT, old.id)
    assert.equal(recovered?.status, 'idle')
    assert.equal(recovered.interruptedTurnAt, NOW)
    assert.equal(recovered.currentEpoch, old.currentEpoch)
    assert.equal(recovered.continuationUsed, 5)
    assert.deepEqual(recovered.worktree, old.worktree)
    assert.deepEqual((await getProjectThread(PROJECT, old.id))?.messages, old.messages)
    assert.ok(!restarted.dispatches.includes(old.id), 'the interrupted turn must never replay')
  })

  it('retains the interrupted checkout and enforces the unchanged scheduled cap', async () => {
    const { scheduleId, old, evidence } = await interrupted(1)
    const restarted = await boot(() => false)

    await restarted.service.tick()

    await preserved(evidence)
    assert.equal(restarted.events.at(-1)?.coalescedReason, 'worktree-limit')
    assert.equal((await getThreadMeta(PROJECT, old.id))?.status, 'idle')
    assert.equal(
      restarted.service.list(PROJECT)[0]?.lastWorktreeLimitBlockedBy?.[0]?.threadId,
      old.id,
    )
    assert.equal(restarted.dispatches.length, 0)
    const explicit = await restarted.service.runNow(PROJECT, scheduleId)
    assert.equal(explicit.disposition, 'started', 'Run now remains the explicit cap remedy')
    await restarted.settled(explicit.threadId)
    await preserved(evidence)
  })

  for (const state of ['live', 'unknown', 'unavailable', 'failed'] as const) {
    it(`preserves running state when canonical liveness is ${state}`, async () => {
      const { scheduleId, old, evidence } = await interrupted('unlimited')
      const isActive =
        state === 'unavailable'
          ? undefined
          : (): boolean | null => {
              if (state === 'failed') throw new Error('Runtime owner unavailable')
              return state === 'live' ? true : null
            }
      const restarted = await boot(isActive)
      const path = join(root, 'workspace', PROJECT, old.id, 'meta.json')
      const before = await readFile(path)

      const event = await restarted.service.runNow(PROJECT, scheduleId)

      assert.equal(event.disposition, 'coalesced')
      assert.equal(event.coalescedReason, 'busy')
      assert.equal(restarted.dispatches.length, 0)
      assert.deepEqual(await readFile(path), before)
      await preserved(evidence)
    })
  }

  it('preserves an unsent scheduled draft despite proof that no turn has started', async () => {
    const { scheduleId, old, evidence } = await interrupted('unlimited')
    await updateMetaOrThrow(PROJECT, old.id, {
      status: 'idle',
      draftPrompt: 'Unsent task.',
      interruptedTurnAt: NOW,
    })
    let checks = 0
    const restarted = await boot(() => {
      checks++
      return false
    })

    const event = await restarted.service.runNow(PROJECT, scheduleId)

    assert.equal(event.coalescedReason, 'busy')
    assert.equal(checks, 0, 'a pending draft is outside interrupted-running repair')
    const current = await getThreadMeta(PROJECT, old.id)
    assert.equal(current?.draftPrompt, 'Unsent task.')
    assert.equal(current.interruptedTurnAt, NOW)
    await preserved(evidence)
  })

  it('keeps a newly admitted runtime owner busy at the atomic metadata write', async () => {
    const { scheduleId, old, evidence } = await interrupted('unlimited')
    let checks = 0
    const restarted = await boot(() => ++checks > 1)
    const path = join(root, 'workspace', PROJECT, old.id, 'meta.json')
    const before = await readFile(path)

    const event = await restarted.service.runNow(PROJECT, scheduleId)

    assert.equal(event.disposition, 'coalesced')
    assert.equal(event.coalescedReason, 'busy')
    assert.deepEqual(await readFile(path), before)
    await preserved(evidence)
  })

  it('preserves a fresh turn epoch written while the stale metadata was being inspected', async () => {
    const { scheduleId, old, evidence } = await interrupted('unlimited')
    const restarted = await boot(
      () => false,
      async () => {
        await updateMetaOrThrow(PROJECT, old.id, {
          currentEpoch: 'a-new-human-tree',
          updatedAt: NOW + 1,
        })
      },
    )

    const event = await restarted.service.runNow(PROJECT, scheduleId)

    assert.equal(event.coalescedReason, 'busy')
    const current = await getThreadMeta(PROJECT, old.id)
    assert.equal(current?.status, 'running')
    assert.equal(current.currentEpoch, 'a-new-human-tree')
    assert.equal(current.interruptedTurnAt, undefined)
    await preserved(evidence)
  })

  for (const owner of ['live', 'unknown', 'failed'] as const) {
    it(`keeps repeated admissions busy when a ${owner} owner appears after the repair write`, async () => {
      const { scheduleId, old, evidence } = await interrupted('unlimited')
      let armed = false
      let afterWrite = false
      configureThreadStore({
        workspaceRoot: () => join(root, 'workspace'),
        onProjectWrite: () => {
          if (armed) afterWrite = true
        },
      })
      const restarted = await boot(() => {
        if (!afterWrite) return false
        if (owner === 'failed') throw new Error('Late owner could not be queried')
        return owner === 'live' ? true : null
      })
      armed = true

      for (let attempt = 0; attempt < 2; attempt++) {
        const event = await restarted.service.runNow(PROJECT, scheduleId)
        if (event.disposition === 'started') await restarted.settled(event.threadId)
        assert.equal(afterWrite, true)
        assert.equal(event.disposition, 'coalesced')
        assert.equal(event.coalescedReason, 'busy')
      }
      assert.equal(restarted.dispatches.length, 0)
      await preserved(evidence)
      assert.equal((await getThreadMeta(PROJECT, old.id))?.continuationUsed, 5)
    })
  }

  it('admits one fresh event delivery after the interrupted run is reconciled', async () => {
    const { old, evidence } = await interrupted('unlimited')
    let enabled = false
    let runId = 1
    const created: string[] = []
    const snapshot = (): BranchCiSnapshot => ({
      headSha: 'a'.repeat(40),
      runs: [
        {
          id: runId,
          run_attempt: 1,
          head_branch: 'main',
          head_sha: 'a'.repeat(40),
          status: 'completed',
          conclusion: 'failure',
          updated_at: new Date(NOW).toISOString(),
          html_url: `https://github.com/owner/repo/actions/runs/${String(runId)}`,
          name: 'CI',
        },
      ],
    })
    const service = createBranchCiAutomationService({
      now: () => NOW,
      isPluginEnabled: () => enabled,
      repositoryForProject: async () => 'github.com/owner/repo',
      snapshot: async () => snapshot(),
      getProjectThread,
      createProjectThread: async (projectId, thread) => {
        created.push(thread.id)
        await createThread(projectId, thread)
      },
      releasePreviousRun: async () => ({ released: false, reason: 'uncommitted-changes' }),
      supervisor: () => supervisor,
      inboxStore: new FileEventInboxStore({ COPSE_WORKSPACE_DIR: join(root, 'workspace') }),
    })
    eventServices.push(service)
    const definition = await service.upsert(PROJECT, {
      name: 'Investigate CI',
      branch: 'main',
      prompt: 'Investigate the new failure.',
      model: 'test-provider',
      enabled: true,
      maxLiveWorktrees: 'unlimited',
    })
    assert.ok(old.automation)
    await updateMetaOrThrow(PROJECT, old.id, {
      automation: { ...old.automation, scheduleId: definition.id },
    })
    service.start(
      () => {},
      () => false,
    )
    await service.sync()
    enabled = true
    runId = 2

    await service.poll()
    await supervisor.waitForIdle()

    assert.equal(
      created.length,
      1,
      'the new delivery must not remain silently blocked by a dead run',
    )
    assert.notEqual(created[0], old.id)
    assert.equal((await getThreadMeta(PROJECT, old.id))?.interruptedTurnAt, NOW)
    await preserved(evidence)
    await service.poll()
    await supervisor.waitForIdle()
    assert.equal(created.length, 1, 'repeated polling must not duplicate the delivery')
  })
})
