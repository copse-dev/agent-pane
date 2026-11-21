import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
import { runSerialized } from '../storage/write-queue.ts'
import { allocateThreadWorktree } from '../worktree-manager.ts'
import { releaseCompletedAutomationWorktree } from '../worktree-parking.ts'
import { hasActiveAcpTurn } from '../acp/acp-session-pool.ts'
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
    ownsAgentWork?: () => boolean | null,
  ): Promise<{
    service: ReturnType<typeof createAutomationService>
    events: AutomationTriggerEvent[]
    dispatches: string[]
    settled: (threadId: string) => Promise<void>
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
      ownsAgentWork ?? isActive,
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

  for (const source of ['manual', 'schedule'] as const) {
    it(`admits a ${source} run while a closed legacy completed run keeps its manual draft`, async () => {
      const { service, events, dispatches, settled } = await boot(() => false)
      const schedule = await service.upsert(PROJECT, {
        name: 'Legacy project check',
        cron: '* * * * *',
        prompt: 'Check the project.',
        model: 'test-provider',
        enabled: source === 'schedule',
        maxLiveWorktrees: 'unlimited',
      })
      const old: Thread = {
        id: 'legacy-completed',
        title: schedule.name,
        status: 'idle',
        usage: { inputTokens: 0, outputTokens: 0 },
        draftPrompt: 'Keep this follow-up manual.',
        automation: {
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          triggeredAt: NOW - 60_000,
        },
        currentEpoch: 'legacy-human-tree',
        continuationUsed: 3,
        messages: [
          {
            id: 'legacy-prompt',
            role: 'user',
            content: 'Check the project.',
            toolCalls: [],
            createdAt: NOW - 60_000,
          },
          {
            id: 'legacy-answer',
            role: 'assistant',
            content: 'The check finished.',
            toolCalls: [],
            createdAt: NOW - 59_000,
          },
        ],
        createdAt: NOW - 60_000,
        updatedAt: NOW - 59_000,
      }
      await saveProjectThread(PROJECT, old)
      closeThreadStoreIndexes()
      const before = await getThreadMeta(PROJECT, old.id)
      assert.ok(before)
      for (const key of [
        'lastPromptAt',
        'lastSettledAt',
        'autoTitleCount',
        'workingBrief',
      ] as const)
        assert.equal(before[key], undefined)
      const spine = join(root, 'workspace', PROJECT, old.id, 'events.jsonl')
      const history = await readFile(spine)
      const metadataOnly = (await loadProjectThreadMetas(PROJECT)).find(
        (thread) => thread.id === old.id,
      )
      assert.equal(metadataOnly?.messagesLoaded, false)
      assert.deepEqual(metadataOnly.messages, [])

      if (source === 'manual') {
        const event = await service.runNow(PROJECT, schedule.id)
        assert.equal(event.disposition, 'started')
        await settled(event.threadId)
      } else {
        await service.tick(NOW)
        const started = events.find((event) => event.disposition === 'started')
        assert.ok(started, 'legacy completed history must not coalesce a scheduled trigger')
        await settled(started.threadId)
      }
      const repeat = await service.runNow(PROJECT, schedule.id)
      assert.equal(repeat.disposition, 'started')
      await settled(repeat.threadId)
      assert.equal(dispatches.length, 2)
      assert.ok(!dispatches.includes(old.id))
      assert.deepEqual(await readFile(spine), history)
      assert.deepEqual(await getThreadMeta(PROJECT, old.id), before)
    })
  }

  it('keeps proven legacy history busy while the separate agent-work owner is live', async () => {
    let ownsWork = true
    const restarted = await boot(
      () => false,
      undefined,
      () => ownsWork,
    )
    const schedule = await restarted.service.upsert(PROJECT, {
      name: 'Legacy owned check',
      cron: '* * * * *',
      prompt: 'Check the project.',
      model: 'test-provider',
      enabled: false,
      maxLiveWorktrees: 'unlimited',
    })
    const old: Thread = {
      id: 'legacy-agent-owned',
      title: schedule.name,
      status: 'idle',
      usage: { inputTokens: 0, outputTokens: 0 },
      draftPrompt: 'Keep this manual.',
      automation: {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        triggeredAt: NOW - 60_000,
      },
      messages: [
        {
          id: 'human',
          role: 'user',
          content: schedule.prompt,
          toolCalls: [],
          createdAt: NOW - 60_000,
        },
        {
          id: 'answer',
          role: 'assistant',
          content: 'Checked.',
          toolCalls: [],
          createdAt: NOW - 59_000,
        },
      ],
      createdAt: NOW - 60_000,
      updatedAt: NOW - 59_000,
    }
    await saveProjectThread(PROJECT, old)
    const before = await getThreadMeta(PROJECT, old.id)
    const blocked = await restarted.service.runNow(PROJECT, schedule.id)
    assert.equal(blocked.coalescedReason, 'busy')
    assert.equal(restarted.dispatches.length, 0)
    assert.deepEqual(await getThreadMeta(PROJECT, old.id), before)
    ownsWork = false
    const started = await restarted.service.runNow(PROJECT, schedule.id)
    assert.equal(started.disposition, 'started')
    assert.notEqual(started.threadId, old.id)
    await restarted.settled(started.threadId)
    assert.deepEqual(await getThreadMeta(PROJECT, old.id), before)
  })

  for (const evidence of [
    'modern',
    'legacy',
    'late-live',
    'late-unknown',
    'late-failed',
  ] as const) {
    it(`applies ${evidence} evidence to the same clean checkout at the default cap`, async () => {
      const priorWorktrees = process.env['COPSE_WORKTREES_DIR']
      process.env['COPSE_WORKTREES_DIR'] = join(root, 'worktrees')
      try {
        const repo = join(root, 'repo')
        await mkdir(repo)
        const git = (...args: string[]): string =>
          execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
            cwd: repo,
            encoding: 'utf8',
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: 'Copse Test',
              GIT_AUTHOR_EMAIL: 'copse@example.invalid',
              GIT_COMMITTER_NAME: 'Copse Test',
              GIT_COMMITTER_EMAIL: 'copse@example.invalid',
            },
          }).trim()
        git('init', '-q', '-b', 'main')
        await writeFile(join(repo, 'README.md'), 'Clean project.\n')
        git('add', 'README.md')
        git('commit', '-qm', 'base')
        storageSet('projects', [{ id: PROJECT, path: repo }])
        const events: AutomationTriggerEvent[] = []
        const finished = Promise.withResolvers<undefined>()
        let checks = 0
        const service = createAutomationService({
          now: () => NOW,
          isPluginEnabled: () => true,
          createProjectThread: createThread,
          releasePreviousRun: releaseCompletedAutomationWorktree,
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
            if (event.headlessSettled) finished.resolve(undefined)
          },
          async (request, host) => {
            host.emit(request.threadId, { type: 'done' })
          },
          () => 'another-project',
          (_projectId, threadId) => {
            if (evidence === 'modern' || evidence === 'legacy') return hasActiveAcpTurn(threadId)
            checks++
            // Reconciliation and the outer fenced release each prove absence
            // twice. Change ownership at the final idle-ACP mutation recheck.
            if (checks <= 4) return false
            if (evidence === 'late-failed') throw new Error('Late owner unavailable')
            return evidence === 'late-live' ? true : null
          },
        )
        const schedule = await service.upsert(PROJECT, {
          name: 'Clean check',
          cron: '* * * * *',
          prompt: 'Check the project.',
          model: 'test-provider',
          enabled: true,
        })
        const worktree = await allocateThreadWorktree({
          projectId: PROJECT,
          threadId: 'clean-previous',
          projectRoot: repo,
          prompt: schedule.prompt,
          baseBranch: 'main',
        })
        assert.equal(git('-C', worktree.path, 'status', '--porcelain'), '')
        const old: Thread = {
          id: 'clean-previous',
          title: schedule.name,
          status: 'idle',
          usage: { inputTokens: 0, outputTokens: 0 },
          draftPrompt: 'Keep this manual.',
          worktree,
          automation: {
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            triggeredAt: NOW - 60_000,
          },
          messages: [
            {
              id: 'human',
              role: 'user',
              content: schedule.prompt,
              toolCalls: [],
              createdAt: NOW - 60_000,
            },
            {
              id: 'answer',
              role: 'assistant',
              content: 'The check finished.',
              toolCalls: [],
              createdAt: NOW - 59_000,
            },
          ],
          createdAt: NOW - 60_000,
          updatedAt: NOW - 59_000,
          ...(evidence === 'modern' ? { lastPromptAt: NOW - 60_000 } : {}),
        }
        await saveProjectThread(PROJECT, old)
        await service.tick(NOW)
        const current = await getThreadMeta(PROJECT, old.id)
        assert.ok(current)
        assert.equal(current.draftPrompt, old.draftPrompt)
        assert.equal(current.lastPromptAt, evidence === 'modern' ? NOW - 60_000 : undefined)
        if (evidence === 'modern' || evidence === 'legacy') {
          assert.ok(
            events.some((event) => event.disposition === 'started'),
            `${evidence} evidence must follow the same clean-checkout/default-cap policy`,
          )
          assert.ok(current.worktree?.retiredAt)
          await finished.promise
        } else {
          assert.equal(
            events.some((event) => event.disposition === 'started'),
            false,
          )
          assert.equal(events.at(-1)?.coalescedReason, 'worktree-limit')
          assert.equal(current.worktree?.retiredAt, undefined)
          assert.equal(await readFile(join(worktree.path, 'README.md'), 'utf8'), 'Clean project.\n')
        }
      } finally {
        if (priorWorktrees === undefined) delete process.env['COPSE_WORKTREES_DIR']
        else process.env['COPSE_WORKTREES_DIR'] = priorWorktrees
      }
    })
  }

  for (const history of [
    'unstarted',
    'human-only',
    'assistant-only',
    'machine-only',
    'hook-only',
    'invalid',
    'unreadable',
  ] as const) {
    it(`keeps ${history} history pending when it cannot prove a submitted legacy prompt`, async () => {
      const { service, dispatches } = await boot(() => false)
      const schedule = await service.upsert(PROJECT, {
        name: 'Pending check',
        cron: '* * * * *',
        prompt: 'Check the project.',
        model: 'test-provider',
        enabled: false,
        maxLiveWorktrees: 'unlimited',
      })
      const old: Thread = {
        id: 'pending-legacy',
        title: schedule.name,
        status: 'idle',
        draftPrompt: 'Check the project.',
        usage: { inputTokens: 0, outputTokens: 0 },
        automation: {
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          triggeredAt: NOW - 60_000,
        },
        messages:
          history === 'unstarted'
            ? []
            : [
                {
                  id: 'history',
                  role: history === 'assistant-only' ? 'assistant' : 'user',
                  content: 'History',
                  toolCalls: [],
                  createdAt: NOW - 60_000,
                  ...(history === 'machine-only'
                    ? { origin: { kind: 'machine', operationId: 'wake' } }
                    : {}),
                  ...(history === 'hook-only'
                    ? { origin: { kind: 'hook', hookId: 'h', event: 'stop' } }
                    : {}),
                },
              ],
        createdAt: NOW - 60_000,
        updatedAt: NOW - 59_000,
      }
      await saveProjectThread(PROJECT, old)
      const spine = join(root, 'workspace', PROJECT, old.id, 'events.jsonl')
      if (history === 'invalid') await writeFile(spine, '{invalid spine}\n')
      if (history === 'unreadable') {
        await rm(spine)
        await mkdir(spine)
      }
      closeThreadStoreIndexes()
      const before = await getThreadMeta(PROJECT, old.id)
      const event = await service.runNow(PROJECT, schedule.id)
      assert.equal(event.coalescedReason, 'busy')
      assert.equal(event.threadId, old.id)
      assert.deepEqual(dispatches, [])
      assert.deepEqual(await getThreadMeta(PROJECT, old.id), before)
    })
  }

  for (const owner of ['live', 'unknown', 'failed'] as const) {
    it(`keeps repeated legacy admissions busy while ownership is ${owner}`, async () => {
      const { scheduleId, old, evidence } = await interrupted('unlimited')
      await saveProjectThread(PROJECT, { ...old, status: 'idle', draftPrompt: 'Keep this manual.' })
      const restarted = await boot(() => {
        if (owner === 'failed') throw new Error('Owner unavailable')
        return owner === 'live' ? true : null
      })
      const path = join(root, 'workspace', PROJECT, old.id, 'meta.json')
      const before = await readFile(path)
      for (let attempt = 0; attempt < 2; attempt++) {
        const event = await restarted.service.runNow(PROJECT, scheduleId)
        assert.equal(event.coalescedReason, 'busy')
      }
      assert.equal(restarted.dispatches.length, 0)
      assert.deepEqual(await readFile(path), before)
      await preserved(evidence)
    })

    it(`keeps a ${owner} owner appearing during the queued legacy read busy on later attempts`, async () => {
      const { scheduleId, old, evidence } = await interrupted('unlimited')
      await saveProjectThread(PROJECT, { ...old, status: 'idle', draftPrompt: 'Keep this manual.' })
      const initialProbe = Promise.withResolvers<undefined>()
      const readBarrier = Promise.withResolvers<undefined>()
      let queued: Promise<undefined> | undefined
      let late = false
      const restarted = await boot(
        () => {
          initialProbe.resolve(undefined)
          if (!late) return false
          if (owner === 'failed') throw new Error('Late owner unavailable')
          return owner === 'live' ? true : null
        },
        async () => {
          queued ??= runSerialized(`thread-store:${PROJECT}`, () => readBarrier.promise)
        },
      )
      const before = await getThreadMeta(PROJECT, old.id)
      const pending = restarted.service.runNow(PROJECT, scheduleId)
      try {
        await initialProbe.promise
        late = true
        readBarrier.resolve(undefined)
        assert.equal((await pending).coalescedReason, 'busy')
        assert.equal((await restarted.service.runNow(PROJECT, scheduleId)).coalescedReason, 'busy')
        assert.equal(restarted.dispatches.length, 0)
        assert.deepEqual(await getThreadMeta(PROJECT, old.id), before)
        await preserved(evidence)
      } finally {
        readBarrier.resolve(undefined)
        await queued
        await pending
      }
    })
  }

  it('rechecks legacy ownership after the queued evidence read', async () => {
    const { scheduleId, old, evidence } = await interrupted('unlimited')
    await saveProjectThread(PROJECT, { ...old, status: 'idle', draftPrompt: 'Keep this manual.' })
    let checks = 0
    const restarted = await boot(() => ++checks > 1)
    const before = await getThreadMeta(PROJECT, old.id)
    for (let attempt = 0; attempt < 2; attempt++) {
      const event = await restarted.service.runNow(PROJECT, scheduleId)
      assert.equal(event.coalescedReason, 'busy')
    }
    assert.equal(restarted.dispatches.length, 0)
    assert.deepEqual(await getThreadMeta(PROJECT, old.id), before)
    await preserved(evidence)
  })

  it('does not turn uncertain ordinary idle run evidence into a new legacy blocker', async () => {
    const { scheduleId, old, evidence } = await interrupted('unlimited')
    await saveProjectThread(PROJECT, {
      ...old,
      status: 'idle',
      draftPrompt: 'Keep this manual.',
      usage: { inputTokens: 1, outputTokens: 0 },
    })
    const restarted = await boot(() => null)
    const event = await restarted.service.runNow(PROJECT, scheduleId)
    assert.equal(event.disposition, 'started')
    await restarted.settled(event.threadId)
    await preserved(evidence)
  })

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

  it('keeps the scheduled worktree cap after resolving legacy completed draft evidence', async () => {
    const { scheduleId, old, evidence } = await interrupted(1)
    await saveProjectThread(PROJECT, { ...old, status: 'idle', draftPrompt: 'Keep this manual.' })
    const restarted = await boot(() => false)
    await restarted.service.tick(NOW)
    assert.equal(restarted.events.at(-1)?.coalescedReason, 'worktree-limit')
    assert.equal(restarted.dispatches.length, 0)
    const current = await getThreadMeta(PROJECT, old.id)
    assert.ok(current)
    assert.equal(current.lastPromptAt, undefined)
    assert.equal(current.draftPrompt, 'Keep this manual.')
    assert.deepEqual(current.worktree, old.worktree)
    await preserved(evidence)
    assert.ok(restarted.service.list(PROJECT).find((schedule) => schedule.id === scheduleId))
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

  for (const liveness of ['live', 'absent', 'unknown', 'unavailable', 'failed'] as const) {
    it(`checks ${liveness} ownership before admitting a run after an idle prompt`, async () => {
      const { scheduleId, old, evidence } = await interrupted('unlimited')
      await updateMetaOrThrow(PROJECT, old.id, { status: 'idle' })
      let active = liveness === 'live'
      const restarted = await boot(
        liveness === 'unavailable'
          ? undefined
          : (): boolean | null => {
              if (liveness === 'failed') throw new Error('Owner unavailable')
              return liveness === 'unknown' ? null : active
            },
      )
      const path = join(root, 'workspace', PROJECT, old.id, 'meta.json')
      const before = await readFile(path)
      const event = await restarted.service.runNow(PROJECT, scheduleId)
      if (active) {
        assert.equal(event.coalescedReason, 'busy')
        assert.equal(restarted.dispatches.length, 0)
        active = false
        const next = await restarted.service.runNow(PROJECT, scheduleId)
        assert.equal(next.disposition, 'started')
        assert.notEqual(next.threadId, old.id)
        await restarted.settled(next.threadId)
      } else {
        assert.equal(event.disposition, 'started')
        await restarted.settled(event.threadId)
      }
      assert.equal(restarted.dispatches.length, 1)
      assert.deepEqual(await readFile(path), before)
      await preserved(evidence)
    })
  }

  it('preserves a genuinely empty unsent scheduled draft', async () => {
    let checks = 0
    const restarted = await boot(() => {
      checks++
      return false
    })
    const schedule = await restarted.service.upsert(PROJECT, {
      name: 'Unstarted check',
      cron: '* * * * *',
      prompt: 'Unsent task.',
      model: 'test-provider',
      enabled: false,
      maxLiveWorktrees: 'unlimited',
    })
    // An unstarted task has no submitted prompt in its committed history.
    const old: Thread = {
      id: 'unstarted-run',
      title: schedule.name,
      status: 'idle',
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      draftPrompt: 'Unsent task.',
      interruptedTurnAt: NOW,
      automation: { scheduleId: schedule.id, scheduleName: schedule.name, triggeredAt: NOW },
      createdAt: NOW,
      updatedAt: NOW,
    }
    await saveProjectThread(PROJECT, old)
    const before = await getThreadMeta(PROJECT, old.id)

    const event = await restarted.service.runNow(PROJECT, schedule.id)

    assert.equal(event.coalescedReason, 'busy')
    assert.equal(checks, 0, 'a pending draft is outside interrupted-running repair')
    const current = await getThreadMeta(PROJECT, old.id)
    assert.equal(current?.draftPrompt, 'Unsent task.')
    assert.equal(current.interruptedTurnAt, NOW)
    assert.deepEqual(current, before)
  })

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

  for (const prior of ['interrupted', 'legacy-completed-draft'] as const) {
    it(`admits one fresh event delivery after the ${prior} run is reconciled`, async () => {
      const { old, evidence } = await interrupted('unlimited')
      if (prior === 'legacy-completed-draft')
        await saveProjectThread(PROJECT, {
          ...old,
          status: 'idle',
          draftPrompt: 'Keep this manual.',
        })
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
      await updateMetaOrThrow(PROJECT, old.id, { status: 'idle' })
      service.start(
        () => {},
        () => true,
        () => true,
      )
      await service.poll()
      await supervisor.waitForIdle()
      assert.equal(created.length, 0, 'idle metadata cannot admit another event while work is live')
      await preserved(evidence)
      service.start(
        () => {},
        () => false,
      )
      // Restore this fixture's original state: interrupted runs still need repair,
      // while legacy completed history must remain eligible for transient proof.
      await updateMetaOrThrow(PROJECT, old.id, {
        status: prior === 'interrupted' ? 'running' : 'idle',
      })

      await service.poll()
      await supervisor.waitForIdle()

      assert.equal(
        created.length,
        1,
        'the new delivery must not remain silently blocked by a dead run',
      )
      assert.notEqual(created[0], old.id)
      const previous = await getThreadMeta(PROJECT, old.id)
      assert.equal(previous?.interruptedTurnAt, prior === 'interrupted' ? NOW : undefined)
      if (prior === 'legacy-completed-draft') {
        assert.ok(previous)
        assert.equal(previous.lastPromptAt, undefined)
        assert.equal(previous.draftPrompt, 'Keep this manual.')
      }
      await preserved(evidence)
      await service.poll()
      await supervisor.waitForIdle()
      assert.equal(created.length, 1, 'repeated polling must not duplicate the delivery')
    })
  }
})
