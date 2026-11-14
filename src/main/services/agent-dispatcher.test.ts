import { withIsolatedWorkerDispatchSlot } from './agents/isolated-worker-scope.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LLMMessage, StreamChunk, UserContent } from '@shared/types'
import type { SpineMachineContinuationLine } from '@shared/threads/spine-schema.ts'
import type { MachineDispatchResult } from '@shared/types/machine-dispatch.ts'
import type { AgentHost } from '@copse/agent/agent-host.ts'
import { ToolRegistry } from './tool-registry.ts'
import {
  AgentDispatcher,
  type AgentDispatcherDependencies,
  type TurnTranscriptSink,
  type AgentDispatchRequest,
} from './agent-dispatcher.ts'
import type { ThreadExecutionContext } from './thread-execution-context.ts'
import { getRunPlan } from './thread-plan-context.ts'
import type { StoredThreadPlan } from '@copse/thread-store/plan-schema.ts'
import type { TodoItem } from '@shared/types/todo.ts'
import { isDeferralModeActive } from './security/deferral-mode.ts'
import { hasAutomationGrantScope } from './security/automation-grant-scope.ts'

const host: AgentHost<StreamChunk> = { emit: () => undefined }
const registry = new ToolRegistry()
const context: ThreadExecutionContext = {
  projectId: 'project-1',
  threadId: 'thread-1',
  projectRoot: '/workspace',
  root: '/workspace',
  checkoutMode: 'shared',
  branch: null,
}

/** Let the checkpoint writer's queued write actually run before asserting. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function request(overrides?: Partial<AgentDispatchRequest>): AgentDispatchRequest {
  return {
    projectId: 'project-1',
    threadId: 'thread-1',
    payload: { userContent: 'continue', invokedSkills: [], priorTodos: [] },
    ...overrides,
  }
}

function dependencies(
  overrides?: Partial<AgentDispatcherDependencies>,
): AgentDispatcherDependencies {
  return {
    loadHistory: async () => [],
    saveHistory: async () => undefined,
    recoverHistory: async () => [],
    loadEpoch: async () => null,
    saveEpoch: async () => undefined,
    appendMachineContinuation: async () => undefined,
    now: () => 100,
    createId: () => 'audit-id',
    loadPlan: async () => null,
    prepareExecutionContext: async () => context,
    isScheduledAutomationRun: () => false,
    transcriptLength: async () => 0,
    run: async (_threadId, userContent, priorMessages) => ({
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: [...priorMessages, { role: 'user', content: userContent }],
    }),
    ...overrides,
  }
}

describe('AgentDispatcher', () => {
  it('orders an awaited steering checkpoint between earlier and later observational writes', async () => {
    const saved: string[] = []
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        saveHistory: async (_project, _thread, messages) => {
          const first = messages[0]
          assert.ok(first?.role === 'user' && typeof first.content === 'string')
          saved.push(first.content)
        },
        run: async (_id, _content, _prior, _host, _registry, options) => {
          options.onHistoryCheckpoint?.([{ role: 'user', content: 'before' }])
          const committed = options.onSteeringCheckpoint?.([{ role: 'user', content: 'steering' }])
          assert.ok(committed)
          options.onHistoryCheckpoint?.([{ role: 'user', content: 'after' }])
          await committed
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [{ role: 'user', content: 'final' }],
          }
        },
      }),
    )
    await dispatcher.dispatch(request())
    assert.deepEqual(saved, ['before', 'steering', 'after', 'final'])
  })

  it('reports a steering checkpoint failure to the running host', async () => {
    let sawFailure = false
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        saveHistory: async () => {
          throw new Error('disk full')
        },
        run: async (_id, _content, _prior, _host, _registry, options) => {
          assert.ok(options.onSteeringCheckpoint)
          await assert.rejects(options.onSteeringCheckpoint([]), /disk full/)
          sawFailure = true
          return { usage: { inputTokens: 0, outputTokens: 0 }, messages: [] }
        },
      }),
    )
    await assert.rejects(dispatcher.dispatch(request()), /disk full/)
    assert.equal(sawFailure, true)
  })
  it('delivers internal notifications to the model with a hidden turn start and a budget charge', async () => {
    const chunks: StreamChunk[] = []
    const saved: LLMMessage[][] = []
    const epochs: number[] = []
    const dispatcher = new AgentDispatcher(
      {
        emit: (_threadId, chunk): void => {
          chunks.push(chunk)
        },
      },
      registry,
      dependencies({
        loadEpoch: async () => ({ turnTreeId: 'tree-1', continuationUsed: 0 }),
        saveEpoch: async (_project, _thread, epoch) => {
          epochs.push(epoch.continuationUsed)
        },
        saveHistory: async (_project, _thread, history) => {
          saved.push(history)
        },
        run: async (_threadId, content, history, streamHost) => {
          assert.equal(content, 'The user accepted a.txt.')
          streamHost.emit('thread-1', { type: 'done' })
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [...history, { role: 'user', content }],
          }
        },
      }),
    )
    const result = await dispatcher.dispatchMachine({
      ...request({
        payload: { userContent: 'The user accepted a.txt.', invokedSkills: [], priorTodos: [] },
      }),
      operationId: 'accept-1',
      turnTreeId: 'tree-1',
      display: 'hidden',
    })
    assert.equal(result, 'completed')
    assert.equal(dispatcher.isActive('project-1', 'thread-1'), false)
    assert.equal(dispatcher.hasMachineOperationRecord('project-1', 'thread-1'), true)
    assert.equal(dispatcher.hasMachineOperationRecord('another-project', 'thread-1'), false)
    assert.deepEqual(epochs, [1])
    assert.deepEqual(chunks[0], {
      type: 'machine_turn_start',
      hidden: true,
      content: 'The user accepted a.txt.',
      origin: { kind: 'machine', operationId: 'accept-1' },
    })
    assert.deepEqual(saved[0], [{ role: 'user', content: 'The user accepted a.txt.' }])
  })

  it('defers approvals only during the first turn of a verified scheduled run', async () => {
    const automationContext: ThreadExecutionContext = {
      ...context,
      root: '/workspace/.copse/worktrees/thread-1',
      checkoutMode: 'worktree',
      automation: { scheduleId: 'schedule-1', scheduleName: 'Review', triggeredAt: 1 },
    }
    const activeDuringRun: boolean[] = []
    const grantDuringRun: boolean[] = []
    const grantAfterRun: boolean[] = []
    const headlessChunks: StreamChunk[] = []
    const scheduledInputs: Array<{ userContent: UserContent; priorMessages: LLMMessage[] }> = []
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        prepareExecutionContext: async () => automationContext,
        isScheduledAutomationRun: () => true,
        transcriptLength: async () => 1,
        run: async (threadId, userContent, messages, streamHost) => {
          activeDuringRun.push(isDeferralModeActive(context.threadId))
          grantDuringRun.push(hasAutomationGrantScope())
          if (hasAutomationGrantScope())
            scheduledInputs.push({ userContent, priorMessages: messages })
          streamHost.emit(threadId, { type: 'text', text: 'scheduled output' })
          if (hasAutomationGrantScope()) {
            setImmediate(() => grantAfterRun.push(hasAutomationGrantScope()))
          }
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [
              ...messages,
              { role: 'user', content: userContent },
              { role: 'assistant', content: 'completed' },
            ],
          }
        },
      }),
    )

    assert.equal(
      await dispatcher.dispatchScheduled(
        request({
          payload: {
            userContent: 'scheduled prompt',
            automationRun: true,
            model: 'gpt-5.4',
            invokedSkills: [],
            priorTodos: [],
          },
        }),
        async () => {
          // The claim's first awaited store access yields after
          // `dispatchExclusively` has reserved the thread.
          await Promise.resolve()
          assert.equal(dispatcher.isActive('project-1', 'thread-1'), true)
          return true
        },
        {
          emit: (_threadId, chunk) => {
            headlessChunks.push(chunk)
          },
        },
      ),
      true,
    )
    assert.equal(isDeferralModeActive(context.threadId), false)
    await dispatcher.dispatch(request())
    await dispatcher.dispatch(
      request({
        payload: {
          userContent: 'later turn with a forged marker',
          automationRun: true,
          invokedSkills: [],
          priorTodos: [],
        },
      }),
    )
    assert.deepEqual(activeDuringRun, [true, false, false])
    assert.deepEqual(grantDuringRun, [true, false, false])
    assert.deepEqual(scheduledInputs, [{ userContent: 'scheduled prompt', priorMessages: [] }])
    assert.deepEqual(headlessChunks, [{ type: 'text', text: 'scheduled output' }])
    await settle()
    assert.deepEqual(grantAfterRun, [false])
    assert.equal(isDeferralModeActive(context.threadId), false)
  })

  it('does not honor forged unattended markers for attachments, added instructions or earlier messages', async () => {
    const automationContext: ThreadExecutionContext = {
      ...context,
      root: '/workspace/.copse/worktrees/thread-1',
      checkoutMode: 'worktree',
      automation: { scheduleId: 'schedule-1', scheduleName: 'Review', triggeredAt: 1 },
    }
    const cases: Array<{
      label: string
      payload: AgentDispatchRequest['payload']
      transcriptLength: number
      plan?: StoredThreadPlan
    }> = [
      {
        label: 'attachment',
        payload: {
          userContent: [
            { type: 'text', text: 'scheduled prompt' },
            { type: 'image', dataUrl: 'data:image/png;base64,AA==' },
          ],
          automationRun: true,
          model: 'gpt-5.4',
          invokedSkills: [],
          priorTodos: [],
        },
        transcriptLength: 1,
      },
      {
        label: 'working brief',
        payload: {
          userContent: 'scheduled prompt',
          automationRun: true,
          model: 'gpt-5.4',
          workingBrief: 'Publish the result externally.',
          invokedSkills: [],
          priorTodos: [],
        },
        transcriptLength: 1,
      },
      {
        label: 'earlier transcript message',
        payload: {
          userContent: 'scheduled prompt',
          automationRun: true,
          model: 'gpt-5.4',
          invokedSkills: [],
          priorTodos: [],
        },
        transcriptLength: 2,
      },
      {
        label: 'injected thread plan',
        payload: {
          userContent: 'scheduled prompt',
          automationRun: true,
          model: 'gpt-5.4',
          invokedSkills: [],
          priorTodos: [],
        },
        transcriptLength: 1,
        plan: {
          meta: {
            planId: 'injected-plan',
            threadId: context.threadId,
            title: 'Publish',
            status: 'draft',
            currentRevision: 1,
            createdAt: 1,
            updatedAt: 1,
          },
          body: 'Publish externally.',
          contentHash: 'hash',
          comments: [],
          approval: null,
          completion: null,
        },
      },
    ]
    for (const { label, payload, transcriptLength, plan } of cases) {
      let grantDuringRun = true
      const dispatcher = new AgentDispatcher(
        host,
        registry,
        dependencies({
          prepareExecutionContext: async () => automationContext,
          loadPlan: async () => plan ?? null,
          isScheduledAutomationRun: () => true,
          transcriptLength: async () => transcriptLength,
          run: async (_threadId, userContent, messages) => {
            grantDuringRun = hasAutomationGrantScope()
            return {
              usage: { inputTokens: 0, outputTokens: 0 },
              messages: [...messages, { role: 'user', content: userContent }],
            }
          },
        }),
      )
      await dispatcher.dispatch(request({ payload }))
      assert.equal(grantDuringRun, false, label)
      assert.equal(isDeferralModeActive(context.threadId), false, label)
    }
  })

  it('opens no transcript and runs nothing when a scheduled renderer grant is rejected', async () => {
    let runs = 0
    let transcripts = 0
    let claims = 0
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        prepareExecutionContext: async () => ({
          ...context,
          root: '/workspace/.copse/worktrees/thread-1',
          checkoutMode: 'worktree',
        }),
        run: async (): Promise<{
          usage: { inputTokens: number; outputTokens: number }
          messages: LLMMessage[]
        }> => {
          runs += 1
          return { usage: { inputTokens: 0, outputTokens: 0 }, messages: [] }
        },
      }),
      {
        begin: (): { emit: () => void; end: () => void } => {
          transcripts += 1
          return { emit: (): void => undefined, end: (): void => undefined }
        },
      },
    )

    const accepted = await dispatcher.dispatchScheduled(request(), () => {
      claims += 1
      return Promise.resolve(false)
    })

    assert.equal(accepted, false)
    assert.equal(claims, 1)
    assert.equal(runs, 0)
    assert.equal(transcripts, 0)
  })

  it('does not consume a scheduled grant or run in the shared project checkout', async () => {
    let claims = 0
    let runs = 0
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        prepareExecutionContext: async () => ({
          ...context,
          automation: { scheduleId: 'schedule-1', scheduleName: 'Review', triggeredAt: 1 },
        }),
        isScheduledAutomationRun: () => true,
        run: async () => {
          runs += 1
          return { usage: { inputTokens: 0, outputTokens: 0 }, messages: [] }
        },
      }),
    )

    const accepted = await dispatcher.dispatchScheduled(
      request({
        payload: {
          userContent: 'scheduled prompt',
          automationRun: true,
          model: 'gpt-5.4',
          invokedSkills: [],
          priorTodos: [],
        },
      }),
      () => {
        claims += 1
        return Promise.resolve(true)
      },
    )

    assert.equal(accepted, false)
    assert.equal(claims, 0)
    assert.equal(runs, 0)
    assert.equal(hasAutomationGrantScope(), false)
  })

  it('does not claim a delegated prompt in the shared project checkout', async () => {
    let claims = 0
    let runs = 0
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        prepareExecutionContext: async () => context,
        run: async () => {
          runs += 1
          return { usage: { inputTokens: 0, outputTokens: 0 }, messages: [] }
        },
      }),
    )

    const accepted = await dispatcher.dispatchProtectedWorktree('project-1', 'thread-1', () => {
      claims += 1
      return Promise.resolve(request())
    })

    assert.equal(accepted, false)
    assert.equal(claims, 0)
    assert.equal(runs, 0)
  })

  it('claims a delegated prompt only after reserving its isolated execution context', async () => {
    let claims = 0
    let runs = 0
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        prepareExecutionContext: async () => ({
          ...context,
          root: '/workspace/.copse/worktrees/thread-1',
          checkoutMode: 'worktree',
        }),
        run: async () => {
          runs += 1
          return { usage: { inputTokens: 0, outputTokens: 0 }, messages: [] }
        },
      }),
    )

    const accepted = await dispatcher.dispatchProtectedWorktree(
      'project-1',
      'thread-1',
      async () => {
        claims += 1
        assert.equal(dispatcher.isActive('project-1', 'thread-1'), true)
        return request()
      },
    )

    assert.equal(accepted, true)
    assert.equal(claims, 1)
    assert.equal(runs, 1)
  })

  it('reserves the primary-turn slot for workers until execution and cleanup settle', async () => {
    await assert.rejects(
      withIsolatedWorkerDispatchSlot(
        { projectId: 'project-1', threadId: 'worker' },
        async () => undefined,
      ),
      /owning dispatcher/,
    )
    let entered = (): void => {
      throw new Error('uninitialized')
    }
    let release = (): void => {
      throw new Error('uninitialized')
    }
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const pendingCleanup = new Promise<void>((resolve) => {
      release = resolve
    })
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        run: async (threadId) => {
          if (threadId === 'thread-1') {
            await withIsolatedWorkerDispatchSlot(
              { projectId: 'project-1', threadId: 'worker' },
              async () => {
                entered()
                await pendingCleanup
              },
            )
          }
          return { usage: { inputTokens: 0, outputTokens: 0 }, messages: [] }
        },
      }),
    )
    const parent = dispatcher.dispatch(request())
    await started
    assert.equal(dispatcher.isActive('project-1', 'worker'), true)
    assert.equal(dispatcher.beginThreadHistoryEdit('project-1', 'worker'), false)
    await assert.rejects(dispatcher.dispatch(request({ threadId: 'worker' })), /already running/)
    release()
    await parent
    assert.equal(dispatcher.isActive('project-1', 'worker'), false)
    await dispatcher.dispatch(request({ threadId: 'worker' }))
  })

  it('uses the dispatch slot as an exclusive history-edit fence', async () => {
    const dispatcher = new AgentDispatcher(host, registry, dependencies())

    assert.equal(dispatcher.beginThreadHistoryEdit('project-1', 'thread-1'), true)
    assert.equal(dispatcher.beginThreadHistoryEdit('project-1', 'thread-1'), false)
    await assert.rejects(dispatcher.dispatch(request()), /already running/)

    dispatcher.endThreadHistoryEdit('project-1', 'thread-1')
    await dispatcher.dispatch(request())
  })

  it('uses the committed plan while isolating draft turns from execution todos', async () => {
    const plan: StoredThreadPlan = {
      meta: {
        planId: 'plan-1',
        threadId: context.threadId,
        title: 'Review scope',
        status: 'draft',
        currentRevision: 2,
        createdAt: 1,
        updatedAt: 2,
      },
      body: 'The committed draft',
      contentHash: 'hash',
      comments: [],
      approval: null,
      completion: null,
    }
    const todos: TodoItem[] = [
      { id: 'existing', content: 'Implement the earlier task', status: 'pending' },
    ]
    let turns = 0
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        loadPlan: async () => plan,
        run: async (_threadId, _userContent, messages, _host, _registry, options) => {
          turns++
          assert.equal(getRunPlan(), plan)
          assert.deepEqual(options.priorTodos, [])
          return { usage: { inputTokens: 0, outputTokens: 0 }, messages }
        },
      }),
    )
    await dispatcher.dispatch(
      request({
        payload: { userContent: 'Refine the scope', invokedSkills: [], priorTodos: todos },
      }),
    )
    assert.equal(turns, 1)
    assert.equal(todos[0]?.status, 'pending')
    assert.equal(getRunPlan(), null)
  })

  it('loads history once and commits each completed turn', async () => {
    const loaded: LLMMessage[] = [{ role: 'assistant', content: 'prior' }]
    const saved: LLMMessage[][] = []
    let loadCount = 0
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        loadHistory: async () => {
          loadCount += 1
          return loaded
        },
        saveHistory: async (_projectId, _threadId, messages) => {
          saved.push(messages)
        },
      }),
    )

    await dispatcher.dispatch(request())
    await dispatcher.dispatch(
      request({ payload: { userContent: 'again', invokedSkills: [], priorTodos: [] } }),
    )

    assert.equal(loadCount, 1)
    assert.deepEqual(saved, [
      [...loaded, { role: 'user', content: 'continue' }],
      [...loaded, { role: 'user', content: 'continue' }, { role: 'user', content: 'again' }],
    ])
  })

  it('hands the run the summary of reviews the user ran, alongside the prompt (#2519)', async () => {
    const seen: Array<{ userContent: UserContent; reviewContext: string | undefined }> = []
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        run: async (_threadId, userContent, priorMessages, _host, _registry, options) => {
          seen.push({ userContent, reviewContext: options.reviewContext })
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [...priorMessages, { role: 'user', content: userContent }],
          }
        },
      }),
    )

    await dispatcher.dispatch(
      request({
        payload: {
          userContent: 'fix it',
          invokedSkills: [],
          priorTodos: [],
          reviewContext: '<copse_review_report>…</copse_review_report>',
        },
      }),
    )
    await dispatcher.dispatch(request())

    assert.deepEqual(seen, [
      { userContent: 'fix it', reviewContext: '<copse_review_report>…</copse_review_report>' },
      { userContent: 'continue', reviewContext: undefined },
    ])
  })

  it('tells the run when it is a long-horizon task wake', async () => {
    const seen: Array<true | undefined> = []
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        run: async (_threadId, userContent, priorMessages, _host, _registry, options) => {
          seen.push(options.longTaskWake)
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [...priorMessages, { role: 'user', content: userContent }],
          }
        },
      }),
    )

    await dispatcher.dispatch(
      request({
        payload: { userContent: 'continue', invokedSkills: [], priorTodos: [], longTaskWake: true },
      }),
    )
    await dispatcher.dispatch(request())

    assert.deepEqual(seen, [true, undefined])
  })

  it('rebuilds history from the transcript when the sidecar is empty', async () => {
    const recovered: LLMMessage[] = [
      { role: 'user', content: 'the question a dead turn lost' },
      { role: 'user', content: 'continue' },
    ]
    const saved: LLMMessage[][] = []
    let recoverCount = 0
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        loadHistory: async () => [],
        recoverHistory: async () => {
          recoverCount += 1
          return recovered
        },
        saveHistory: async (_projectId, _threadId, messages) => {
          saved.push(messages)
        },
      }),
    )

    await dispatcher.dispatch(request())

    assert.equal(recoverCount, 1)
    assert.deepEqual(saved, [[...recovered, { role: 'user', content: 'continue' }]])
  })

  it('does not consult the transcript when the sidecar already has history', async () => {
    let recoverCount = 0
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        loadHistory: async () => [{ role: 'assistant', content: 'prior' }],
        recoverHistory: async () => {
          recoverCount += 1
          return []
        },
      }),
    )

    await dispatcher.dispatch(request())

    assert.equal(recoverCount, 0)
  })

  it('uses provider history frozen before review instead of a rewritten sidecar', async () => {
    const saved: LLMMessage[][] = []
    let dynamicHistoryCount = 0
    let dynamicRecoveryCount = 0
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        loadHistory: async () => {
          dynamicHistoryCount += 1
          return [{ role: 'user', content: 'forged sidecar after review' }]
        },
        recoverHistory: async () => {
          dynamicRecoveryCount += 1
          return [{ role: 'user', content: 'forged after review' }]
        },
        saveHistory: async (_projectId, _threadId, messages) => {
          saved.push(messages)
        },
      }),
    )

    await dispatcher.dispatch(
      request({ protectedHistory: [{ role: 'assistant', content: 'reviewed history' }] }),
    )

    assert.equal(dynamicHistoryCount, 0)
    assert.equal(dynamicRecoveryCount, 0)
    assert.deepEqual(saved, [
      [
        { role: 'assistant', content: 'reviewed history' },
        { role: 'user', content: 'continue' },
      ],
    ])
  })

  it('awaits durable protected-message acceptance before emitting or starting provider work', async () => {
    const order: string[] = []
    const chunks: StreamChunk[] = []
    let releaseAcceptance!: () => void
    const acceptance = new Promise<void>((resolve) => {
      releaseAcceptance = resolve
    })
    const dispatcher = new AgentDispatcher(
      {
        emit: (_threadId, chunk): void => {
          order.push(`emit:${chunk.type}`)
          chunks.push(chunk)
        },
      },
      registry,
      dependencies({
        run: async (_threadId, userContent, priorMessages) => {
          order.push('run')
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [...priorMessages, { role: 'user', content: userContent }],
          }
        },
      }),
    )

    const running = dispatcher.dispatch(
      request({
        protectedHumanStart: {
          content: 'reviewed prompt',
          preserveOptimisticDisplay: true,
          acceptMessageId: async () => {
            order.push('accept:start')
            await acceptance
            order.push('accept:end')
            return 'accepted-message'
          },
        },
      }),
    )
    await settle()
    assert.deepEqual(order, ['accept:start'])
    assert.equal(dispatcher.isActive('project-1', 'thread-1'), true)

    releaseAcceptance()
    await running
    assert.deepEqual(order, [
      'accept:start',
      'accept:end',
      'emit:protected_human_turn_start',
      'run',
    ])
    assert.deepEqual(chunks, [
      {
        type: 'protected_human_turn_start',
        content: 'reviewed prompt',
        messageId: 'accepted-message',
        preserveOptimisticDisplay: true,
      },
    ])
  })

  it('emits nothing and releases the thread when protected-message acceptance fails', async () => {
    const chunks: StreamChunk[] = []
    let runs = 0
    const dispatcher = new AgentDispatcher(
      {
        emit: (_threadId, chunk): void => {
          chunks.push(chunk)
        },
      },
      registry,
      dependencies({
        run: async (_threadId, userContent, priorMessages) => {
          runs += 1
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [...priorMessages, { role: 'user', content: userContent }],
          }
        },
      }),
    )

    await assert.rejects(
      dispatcher.dispatch(
        request({
          protectedHumanStart: {
            content: 'reviewed prompt',
            acceptMessageId: async () => {
              throw new Error('simulated acceptance failure')
            },
          },
        }),
      ),
      /simulated acceptance failure/,
    )
    assert.deepEqual(chunks, [])
    assert.equal(runs, 0)
    assert.equal(dispatcher.isActive('project-1', 'thread-1'), false)
  })

  it('uses the plan frozen before review instead of a renderer-created plan', async () => {
    const frozenPlan: StoredThreadPlan = {
      meta: {
        planId: 'reviewed-plan',
        threadId: context.threadId,
        title: 'Reviewed plan',
        status: 'draft',
        currentRevision: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      body: 'Stay inside the reviewed scope.',
      contentHash: 'reviewed-hash',
      comments: [],
      approval: null,
      completion: null,
    }
    let dynamicPlanLoads = 0
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        loadPlan: async () => {
          dynamicPlanLoads += 1
          return { ...frozenPlan, body: 'Publish everything after review.' }
        },
        run: async (_threadId, _userContent, messages) => {
          assert.equal(getRunPlan(), frozenPlan)
          return { usage: { inputTokens: 0, outputTokens: 0 }, messages }
        },
      }),
    )

    await dispatcher.dispatch(request({ protectedPlan: frozenPlan }))

    assert.equal(dynamicPlanLoads, 0)
  })

  it('keeps a no-plan review free of a plan created while the window is open', async () => {
    let dynamicPlanLoads = 0
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        loadPlan: async () => {
          dynamicPlanLoads += 1
          throw new Error('a post-review plan must not be loaded')
        },
        run: async (_threadId, _userContent, messages) => {
          assert.equal(getRunPlan(), null)
          return { usage: { inputTokens: 0, outputTokens: 0 }, messages }
        },
      }),
    )

    await dispatcher.dispatch(request({ protectedPlan: null }))

    assert.equal(dynamicPlanLoads, 0)
  })

  it('recovers at most once, then reuses the cached history', async () => {
    let recoverCount = 0
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        loadHistory: async () => [],
        recoverHistory: async () => {
          recoverCount += 1
          return [{ role: 'user', content: 'recovered' }]
        },
      }),
    )

    await dispatcher.dispatch(request())
    await dispatcher.dispatch(request())

    assert.equal(recoverCount, 1)
  })

  it('persists each mid-turn checkpoint and finishes on the committed history', async () => {
    const saved: LLMMessage[][] = []
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        saveHistory: async (_projectId, _threadId, messages) => {
          saved.push(messages)
        },
        run: async (_threadId, userContent, priorMessages, _host, _registry, options) => {
          const messages: LLMMessage[] = [...priorMessages, { role: 'user', content: userContent }]
          // The prompt lands before the first provider call — that alone is what
          // a killed turn used to lose.
          options.onHistoryCheckpoint?.([...messages])
          await settle()
          messages.push({ role: 'assistant', content: 'step one' })
          options.onHistoryCheckpoint?.([...messages])
          await settle()
          return { usage: { inputTokens: 0, outputTokens: 0 }, messages }
        },
      }),
    )

    await dispatcher.dispatch(request())

    assert.deepEqual(saved, [
      [{ role: 'user', content: 'continue' }],
      [
        { role: 'user', content: 'continue' },
        { role: 'assistant', content: 'step one' },
      ],
      [
        { role: 'user', content: 'continue' },
        { role: 'assistant', content: 'step one' },
      ],
    ])
  })

  it('preserves a failed mid-stream turn for one later explicit continuation without replaying tools', async () => {
    const seenPrior: LLMMessage[][] = []
    let persisted: LLMMessage[] = []
    let runs = 0
    const interrupted: LLMMessage[] = [
      { role: 'user', content: 'Upload the report, then remove the generated file' },
      { role: 'assistant', content: 'The report is uploaded. Cleaning up next.' },
      {
        role: 'assistant',
        content: [{ id: 'upload-1', name: 'run_shell', args: { command: 'upload report.pdf' } }],
      },
      { role: 'tool', toolResults: [{ toolCallId: 'upload-1', result: 'uploaded' }] },
    ]
    const run: AgentDispatcherDependencies['run'] = async (
      _threadId,
      userContent,
      priorMessages,
      _host,
      _registry,
      options,
    ) => {
      runs += 1
      seenPrior.push([...priorMessages])
      if (runs === 1) {
        assert.equal(userContent, 'Upload the report, then remove the generated file')
        options.onHistoryCheckpoint?.(interrupted)
        await settle()
        return {
          usage: { inputTokens: 20, outputTokens: 8 },
          messages: interrupted,
          turnOutcome: {
            status: 'failed',
            stopReason: 'error',
            source: 'provider',
            executor: 'local',
            provider: 'openrouter',
            model: 'openrouter:x-ai/grok-4.5',
            lastEvent: 'tool',
            error: { code: 502, message: 'upstream disconnected' },
            endedAt: 10,
          },
        }
      }
      return {
        usage: { inputTokens: 30, outputTokens: 5 },
        messages: [
          ...priorMessages,
          { role: 'user', content: userContent },
          { role: 'assistant', content: 'Removed the generated file.' },
        ],
      }
    }
    const dispatcherDependencies = (): AgentDispatcherDependencies =>
      dependencies({
        loadHistory: async () => persisted,
        saveHistory: async (_projectId, _threadId, messages) => {
          persisted = [...messages]
        },
        run,
      })
    const dispatcher = new AgentDispatcher(host, registry, dispatcherDependencies())

    await dispatcher.dispatch(
      request({
        payload: {
          userContent: 'Upload the report, then remove the generated file',
          invokedSkills: [],
          priorTodos: [],
        },
      }),
    )
    assert.equal(runs, 1, 'a provider failure never dispatches another turn automatically')

    // Simulate an application restart: the explicit recovery must load the
    // failed turn from the persisted sidecar, not a dispatcher's memory cache.
    const restartedDispatcher = new AgentDispatcher(host, registry, dispatcherDependencies())
    await restartedDispatcher.dispatch(
      request({
        payload: {
          userContent:
            'Continue the interrupted turn from the persisted history. Do not repeat completed tool calls.',
          invokedSkills: [],
          priorTodos: [],
        },
      }),
    )

    assert.equal(runs, 2)
    assert.deepEqual(seenPrior, [[], interrupted])
    assert.equal(
      seenPrior[1]?.filter((message) => message.role === 'tool').length,
      1,
      'the completed tool result is history, not a replayed call',
    )
  })

  it('keeps the checkpointed prompt when the run throws before committing', async () => {
    const saved: LLMMessage[][] = []
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        saveHistory: async (_projectId, _threadId, messages) => {
          saved.push(messages)
        },
        run: (_threadId, userContent, priorMessages, _host, _registry, options) => {
          options.onHistoryCheckpoint?.([...priorMessages, { role: 'user', content: userContent }])
          return Promise.reject(new Error('provider exploded'))
        },
      }),
    )

    await assert.rejects(dispatcher.dispatch(request()), /provider exploded/)

    assert.deepEqual(saved, [[{ role: 'user', content: 'continue' }]])
    // The cache agrees with what reached disk, so the next turn does not resume
    // from a history the sidecar has already moved past.
    assert.deepEqual(await dispatcher.history('project-1', 'thread-1'), [
      { role: 'user', content: 'continue' },
    ])
  })

  it('coalesces checkpoints that arrive while a write is in flight', async () => {
    const saved: LLMMessage[][] = []
    let releaseWrite!: () => void
    const firstWriteStarted = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    let writes = 0
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        saveHistory: async (_projectId, _threadId, messages) => {
          writes += 1
          saved.push(messages)
          if (writes === 1) await firstWriteStarted
        },
        run: async (_threadId, userContent, priorMessages, _host, _registry, options) => {
          const messages: LLMMessage[] = [...priorMessages, { role: 'user', content: userContent }]
          options.onHistoryCheckpoint?.([...messages])
          await Promise.resolve()
          // Three more snapshots stack up behind the blocked first write; only
          // the newest should reach disk.
          for (const step of ['one', 'two', 'three']) {
            messages.push({ role: 'assistant', content: step })
            options.onHistoryCheckpoint?.([...messages])
          }
          releaseWrite()
          return { usage: { inputTokens: 0, outputTokens: 0 }, messages }
        },
      }),
    )

    await dispatcher.dispatch(request())

    // First checkpoint, the newest of the three that queued behind it, and the
    // end-of-turn commit — not one write per checkpoint.
    assert.equal(saved.length, 3)
    assert.deepEqual(saved[0], [{ role: 'user', content: 'continue' }])
    assert.deepEqual(saved[1]?.at(-1), { role: 'assistant', content: 'three' })
    assert.deepEqual(saved[2]?.at(-1), { role: 'assistant', content: 'three' })
  })

  it('rejects a second active dispatch for the same project thread', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        run: async (_threadId, userContent: UserContent, priorMessages) => {
          await gate
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [...priorMessages, { role: 'user', content: userContent }],
          }
        },
      }),
    )

    const first = dispatcher.dispatch(request())
    let displayClaims = 0
    const protectedRetry = request({
      protectedHumanStart: {
        content: 'reviewed prompt',
        acceptMessageId: async () => {
          displayClaims += 1
          return 'optimistic-message'
        },
      },
    })
    await assert.rejects(dispatcher.dispatch(protectedRetry), {
      name: 'AgentTurnBusyError',
      message: /already running for thread "thread-1"/,
    })
    assert.equal(displayClaims, 0)
    release()
    await first
    await dispatcher.dispatch(protectedRetry)
    assert.equal(displayClaims, 1)
    assert.equal(dispatcher.isActive('project-1', 'thread-1'), false)
  })

  it('waits for an active dispatch to release its slot', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        run: async (_threadId, userContent: UserContent, priorMessages) => {
          await gate
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [...priorMessages, { role: 'user', content: userContent }],
          }
        },
      }),
    )

    const dispatch = dispatcher.dispatch(request())
    await settle()
    let idle = false
    const wait = dispatcher.waitForIdle('project-1', 'thread-1').then(() => {
      idle = true
    })
    await settle()
    assert.equal(idle, false)

    release()
    await Promise.all([dispatch, wait])
    assert.equal(idle, true)
  })

  it('fences an out-of-turn history edit behind a running turn instead of racing its commit', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let disk: LLMMessage[] = []
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        loadHistory: async () => disk,
        saveHistory: async (_p, _t, messages) => {
          disk = messages
        },
        run: async (_threadId, userContent: UserContent, priorMessages) => {
          await gate
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [...priorMessages, { role: 'user', content: userContent }],
          }
        },
      }),
    )

    const dispatch = dispatcher.dispatch(request())
    await settle()
    const edit = dispatcher.withExclusiveHistory('project-1', 'thread-1', async () => {
      disk = [...disk, { role: 'assistant', content: 'review' }]
    })
    await settle()
    // The edit has not read or written while the turn owns the thread.
    assert.deepEqual(disk, [])

    release()
    await Promise.all([dispatch, edit])
    assert.deepEqual(disk, [
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'review' },
    ])
  })

  it('waits for machine bookkeeping that began before the deletion fence', async () => {
    let releaseEpoch!: () => void
    const epochGate = new Promise<void>((resolve) => {
      releaseEpoch = resolve
    })
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        loadEpoch: async () => {
          await epochGate
          return null
        },
      }),
    )

    const dispatch = dispatcher.dispatchMachine({
      ...request(),
      operationId: 'wake-before-delete',
      turnTreeId: 'tree-1',
    })
    await settle()
    dispatcher.beginThreadDeletion('project-1', 'thread-1')
    let idle = false
    const wait = dispatcher.waitForIdle('project-1', 'thread-1').then(() => {
      idle = true
    })
    await settle()
    assert.equal(idle, false)

    releaseEpoch()
    assert.equal(await dispatch, 'stale')
    await wait
    assert.equal(idle, true)
  })

  it('rejects foreground and machine dispatches after deletion begins', async () => {
    const dispatcher = new AgentDispatcher(host, registry, dependencies())
    dispatcher.beginThreadDeletion('project-1', 'thread-1')

    await assert.rejects(dispatcher.dispatch(request()), /thread "thread-1" is being deleted/i)
    await assert.rejects(
      dispatcher.dispatchMachine({
        ...request(),
        operationId: 'wake-after-delete',
        turnTreeId: 'tree-1',
      }),
      /thread "thread-1" is being deleted/i,
    )
  })

  it('publishes done after committing history so an immediate follow-up serializes', async () => {
    const saved: LLMMessage[][] = []
    let followUp: Promise<void> | undefined
    let activeWhenDone: boolean | undefined
    const dispatchHost: AgentHost<StreamChunk> = {
      emit: (_threadId, chunk): void => {
        if (chunk.type !== 'done' || followUp !== undefined) return
        activeWhenDone = dispatcher.isActive('project-1', 'thread-1')
        followUp = dispatcher.dispatch(
          request({ payload: { userContent: 'next', invokedSkills: [], priorTodos: [] } }),
        )
        // Keep the listener's synchronous retry observable below without
        // reporting an unhandled rejection before its assertion runs.
        void followUp.catch(() => undefined)
      },
    }
    const dispatcher = new AgentDispatcher(
      dispatchHost,
      registry,
      dependencies({
        saveHistory: async (_projectId, _threadId, messages) => {
          saved.push(messages)
        },
        run: async (_threadId, userContent, priorMessages, streamHost) => {
          const messages: LLMMessage[] = [...priorMessages, { role: 'user', content: userContent }]
          streamHost.emit('thread-1', { type: 'done' })
          return { usage: { inputTokens: 0, outputTokens: 0 }, messages }
        },
      }),
    )

    await dispatcher.dispatch(request())
    await followUp

    assert.equal(activeWhenDone, false)
    assert.deepEqual(saved, [
      [{ role: 'user', content: 'continue' }],
      [
        { role: 'user', content: 'continue' },
        { role: 'user', content: 'next' },
      ],
    ])
  })

  it('does not publish done before the final history commit succeeds', async () => {
    let releaseSave!: () => void
    const saveStarted = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    let releaseCommit!: () => void
    const commit = new Promise<void>((resolve) => {
      releaseCommit = resolve
    })
    const chunks: StreamChunk[] = []
    const dispatcher = new AgentDispatcher(
      {
        emit: (_threadId, chunk): void => {
          chunks.push(chunk)
        },
      },
      registry,
      dependencies({
        saveHistory: async () => {
          releaseSave()
          await commit
        },
        run: async (_threadId, userContent, priorMessages, streamHost) => {
          streamHost.emit('thread-1', { type: 'done' })
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [...priorMessages, { role: 'user', content: userContent }],
          }
        },
      }),
    )

    const dispatch = dispatcher.dispatch(request())
    await saveStarted
    assert.deepEqual(chunks, [])
    assert.equal(dispatcher.isActive('project-1', 'thread-1'), true)
    releaseCommit()
    await dispatch

    assert.deepEqual(chunks, [{ type: 'done' }])
    assert.equal(dispatcher.isActive('project-1', 'thread-1'), false)
  })

  it('does not publish done when the final history commit fails', async () => {
    const chunks: StreamChunk[] = []
    const priorHistories: LLMMessage[][] = []
    const outcome = {
      status: 'completed' as const,
      stopReason: 'end_turn' as const,
      source: 'provider' as const,
      executor: 'local' as const,
      provider: 'test-provider',
      model: 'test-model',
      endedAt: 1,
    }
    let loadHistoryCalls = 0
    let saveHistoryCalls = 0
    const dispatcher = new AgentDispatcher(
      {
        emit: (_threadId, chunk): void => {
          chunks.push(chunk)
        },
      },
      registry,
      dependencies({
        loadHistory: async () => {
          loadHistoryCalls += 1
          return []
        },
        saveHistory: async () => {
          saveHistoryCalls += 1
          if (saveHistoryCalls === 1) throw new Error('history disk full')
        },
        run: async (_threadId, userContent, priorMessages, streamHost) => {
          priorHistories.push(priorMessages)
          streamHost.emit('thread-1', { type: 'turn_outcome', outcome })
          streamHost.emit('thread-1', { type: 'done' })
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [...priorMessages, { role: 'user', content: userContent }],
          }
        },
      }),
    )

    await assert.rejects(dispatcher.dispatch(request()), /history disk full/)

    assert.deepEqual(chunks, [])
    assert.equal(dispatcher.isActive('project-1', 'thread-1'), false)
    await dispatcher.dispatch(
      request({ payload: { userContent: 'retry', invokedSkills: [], priorTodos: [] } }),
    )

    assert.equal(loadHistoryCalls, 2)
    assert.deepEqual(priorHistories, [[], []])
    assert.deepEqual(chunks, [{ type: 'turn_outcome', outcome }, { type: 'done' }])
  })

  it('publishes a machine turn done after releasing the same history ownership', async () => {
    const saved: LLMMessage[][] = []
    let followUp: Promise<void> | undefined
    let activeWhenDone: boolean | undefined
    const dispatchHost: AgentHost<StreamChunk> = {
      emit: (_threadId, chunk): void => {
        if (chunk.type !== 'done' || followUp !== undefined) return
        activeWhenDone = dispatcher.isActive('project-1', 'thread-1')
        followUp = dispatcher.dispatch(
          request({
            payload: { userContent: 'next after machine', invokedSkills: [], priorTodos: [] },
          }),
        )
        void followUp.catch(() => undefined)
      },
    }
    const dispatcher = new AgentDispatcher(
      dispatchHost,
      registry,
      dependencies({
        loadEpoch: async () => ({ turnTreeId: 'tree-1', continuationUsed: 0 }),
        saveHistory: async (_projectId, _threadId, messages) => {
          saved.push(messages)
        },
        run: async (_threadId, userContent, priorMessages, streamHost) => {
          const messages: LLMMessage[] = [...priorMessages, { role: 'user', content: userContent }]
          streamHost.emit('thread-1', { type: 'done' })
          return { usage: { inputTokens: 0, outputTokens: 0 }, messages }
        },
      }),
    )

    const machine = await dispatcher.dispatchMachine({
      ...request(),
      operationId: 'machine-1',
      turnTreeId: 'tree-1',
    })
    await followUp

    assert.equal(machine, 'completed')
    assert.equal(activeWhenDone, false)
    assert.deepEqual(saved, [
      [{ role: 'user', content: 'continue' }],
      [
        { role: 'user', content: 'continue' },
        { role: 'user', content: 'next after machine' },
      ],
    ])
  })

  it('claims the thread while renderer-epoch persistence is still pending', async () => {
    let enteredEpochWrite!: () => void
    let releaseEpochWrite!: () => void
    const epochWriteStarted = new Promise<void>((resolve) => {
      enteredEpochWrite = resolve
    })
    const epochWrite = new Promise<void>((resolve) => {
      releaseEpochWrite = resolve
    })
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        saveEpoch: async () => {
          enteredEpochWrite()
          await epochWrite
        },
      }),
    )

    const dispatch = dispatcher.dispatch(
      request({
        payload: {
          userContent: 'continue',
          invokedSkills: [],
          priorTodos: [],
          turnTreeId: 'tree-1',
          continuationBudgetUsed: 0,
        },
      }),
    )
    await epochWriteStarted
    assert.equal(dispatcher.isActive('project-1', 'thread-1'), true)
    releaseEpochWrite()
    await dispatch
    assert.equal(dispatcher.isActive('project-1', 'thread-1'), false)
  })

  it('does not run when trusted execution context resolution fails', async () => {
    let ran = false
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        prepareExecutionContext: async () => null,
        run: async () => {
          ran = true
          return { usage: { inputTokens: 0, outputTokens: 0 }, messages: [] }
        },
      }),
    )

    await dispatcher.dispatch(request())

    assert.equal(ran, false)
  })

  it('waits for the foreground turn then dispatches one machine continuation', async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const prompts: UserContent[] = []
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        run: async (_threadId, userContent, priorMessages) => {
          prompts.push(userContent)
          if (userContent === 'continue') {
            entered()
            await gate
          }
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [...priorMessages, { role: 'user', content: userContent }],
          }
        },
      }),
    )
    const foreground = dispatcher.dispatch(
      request({
        payload: {
          userContent: 'continue',
          invokedSkills: [],
          priorTodos: [],
          turnTreeId: 'tree-1',
          continuationBudgetUsed: 0,
        },
      }),
    )
    const wake = dispatcher.dispatchMachine({
      ...request(),
      operationId: 'background-1',
      turnTreeId: 'tree-1',
      payload: { userContent: 'task completed', invokedSkills: [], priorTodos: [] },
    })

    await started
    assert.deepEqual(prompts, ['continue'])
    release()
    await foreground
    assert.equal(await wake, 'completed')
    assert.deepEqual(prompts, ['continue', 'task completed'])
  })

  it('claims the thread before machine bookkeeping can yield to a foreground turn', async () => {
    let enteredBookkeeping!: () => void
    let releaseBookkeeping!: () => void
    const bookkeepingStarted = new Promise<void>((resolve) => {
      enteredBookkeeping = resolve
    })
    const bookkeepingGate = new Promise<void>((resolve) => {
      releaseBookkeeping = resolve
    })
    const prompts: UserContent[] = []
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        loadEpoch: async () => ({ turnTreeId: 'tree-1', continuationUsed: 0 }),
        appendMachineContinuation: async (_projectId, _threadId, line) => {
          if (line.phase !== 'started') return
          enteredBookkeeping()
          await bookkeepingGate
        },
        run: async (_threadId, userContent, priorMessages) => {
          prompts.push(userContent)
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [...priorMessages, { role: 'user', content: userContent }],
          }
        },
      }),
    )

    const machine = dispatcher.dispatchMachine({
      ...request(),
      operationId: 'background-1',
      turnTreeId: 'tree-1',
      payload: { userContent: 'machine wake', invokedSkills: [], priorTodos: [] },
    })
    await bookkeepingStarted

    assert.equal(dispatcher.isActive('project-1', 'thread-1'), true)
    try {
      await assert.rejects(
        dispatcher.dispatch(
          request({
            payload: { userContent: 'foreground', invokedSkills: [], priorTodos: [] },
          }),
        ),
        { name: 'AgentTurnBusyError' },
      )
    } finally {
      releaseBookkeeping()
    }
    assert.equal(await machine, 'completed')
    assert.deepEqual(prompts, ['machine wake'])
  })

  it('emits transcript presentation separately from the model-facing continuation', async () => {
    const emitted: StreamChunk[] = []
    const prompts: UserContent[] = []
    const dispatcher = new AgentDispatcher(
      { emit: (_threadId, chunk): void => void emitted.push(chunk) },
      registry,
      dependencies({
        loadEpoch: async () => ({ turnTreeId: 'tree-1', continuationUsed: 0 }),
        run: async (_threadId, userContent, priorMessages) => {
          prompts.push(userContent)
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [...priorMessages, { role: 'user', content: userContent }],
          }
        },
      }),
    )

    assert.equal(
      await dispatcher.dispatchMachine({
        ...request(),
        operationId: 'git-recovery:1',
        turnTreeId: 'tree-1',
        payload: {
          userContent: 'Continue with the attached shell result:\n```\nprivate output\n```',
          invokedSkills: [],
          priorTodos: [],
        },
        display: {
          content: 'Continue after the Git recovery command completed.',
          attachments: [
            { kind: 'shell', label: 'Run · git rebase --continue', content: 'private output' },
          ],
          startingCommit: 'a'.repeat(40),
          dirty: true,
        },
      }),
      'completed',
    )

    assert.deepEqual(prompts, [
      'Continue with the attached shell result:\n```\nprivate output\n```',
    ])
    assert.deepEqual(emitted[0], {
      type: 'machine_turn_start',
      content: 'Continue after the Git recovery command completed.',
      origin: { kind: 'machine', operationId: 'git-recovery:1' },
      attachments: [
        { kind: 'shell', label: 'Run · git rebase --continue', content: 'private output' },
      ],
      startingCommit: 'a'.repeat(40),
      dirty: true,
    })
  })

  it('accepts only the thread-id epoch fallback for a pre-epoch thread', async () => {
    let runCount = 0
    const savedEpochs: Array<{ turnTreeId: string; continuationUsed: number }> = []
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        saveEpoch: async (_projectId, _threadId, epoch) => {
          savedEpochs.push(epoch)
        },
        run: async (_threadId, userContent, priorMessages) => {
          runCount += 1
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [...priorMessages, { role: 'user', content: userContent }],
          }
        },
      }),
    )

    assert.equal(
      await dispatcher.dispatchMachine({
        ...request(),
        operationId: 'legacy-recovery',
        turnTreeId: 'thread-1',
      }),
      'completed',
    )
    assert.equal(runCount, 1)
    assert.deepEqual(savedEpochs, [
      { turnTreeId: 'thread-1', continuationUsed: 0 },
      { turnTreeId: 'thread-1', continuationUsed: 1 },
    ])

    const forged = new AgentDispatcher(
      host,
      registry,
      dependencies({
        run: async () => {
          throw new Error('A non-legacy epoch must not establish authority')
        },
      }),
    )
    assert.equal(
      await forged.dispatchMachine({
        ...request(),
        operationId: 'forged-recovery',
        turnTreeId: 'tree-not-on-disk',
      }),
      'stale',
    )
  })

  it('deduplicates operation ids and rejects stale epochs', async () => {
    let runCount = 0
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        run: async (_threadId, userContent, priorMessages) => {
          runCount += 1
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [...priorMessages, { role: 'user', content: userContent }],
          }
        },
      }),
    )
    await dispatcher.dispatch(
      request({
        payload: {
          userContent: 'root',
          invokedSkills: [],
          priorTodos: [],
          turnTreeId: 'tree-current',
        },
      }),
    )
    const machine = {
      ...request(),
      operationId: 'background-1',
      turnTreeId: 'tree-current',
      payload: { userContent: 'wake', invokedSkills: [], priorTodos: [] },
    }

    assert.equal(await dispatcher.dispatchMachine(machine), 'completed')
    assert.equal(await dispatcher.dispatchMachine(machine), 'duplicate')
    assert.equal(
      await dispatcher.dispatchMachine({
        ...machine,
        operationId: 'background-stale',
        turnTreeId: 'tree-old',
      }),
      'stale',
    )
    assert.equal(runCount, 2)
  })

  it('records compact continuation starts and terminal decisions without prompt content', async () => {
    const audit: SpineMachineContinuationLine[] = []
    const turnOutcome = {
      status: 'failed' as const,
      stopReason: 'error' as const,
      source: 'provider' as const,
      executor: 'local' as const,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      error: { message: 'upstream 502' },
      endedAt: 100,
    }
    let nextId = 0
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        appendMachineContinuation: async (_projectId, _threadId, line) => {
          audit.push(line)
        },
        createId: () => `audit-${String(++nextId)}`,
        run: async (_threadId, userContent, priorMessages) => ({
          usage: { inputTokens: 0, outputTokens: 0 },
          messages: [...priorMessages, { role: 'user', content: userContent }],
          turnOutcome,
        }),
      }),
    )
    await dispatcher.dispatch(
      request({
        payload: {
          userContent: 'root',
          invokedSkills: [],
          priorTodos: [],
          turnTreeId: 'tree-current',
        },
      }),
    )
    const machine = {
      ...request(),
      operationId: 'background-1',
      turnTreeId: 'tree-current',
      payload: { userContent: 'private wake prompt', invokedSkills: [], priorTodos: [] },
    }

    assert.equal(await dispatcher.dispatchMachine(machine), 'completed')
    assert.equal(await dispatcher.dispatchMachine(machine), 'duplicate')
    assert.equal(
      await dispatcher.dispatchMachine({
        ...machine,
        operationId: 'background-stale',
        turnTreeId: 'tree-old',
      }),
      'stale',
    )

    assert.deepEqual(
      audit.map(({ phase, operationId, turnTreeId, budgetUsed, turnOutcome, ...line }) => ({
        id: line.id,
        phase,
        operationId,
        turnTreeId,
        ...(budgetUsed !== undefined ? { budgetUsed } : {}),
        ...('result' in line ? { result: line.result } : {}),
        ...(turnOutcome !== undefined ? { turnOutcome } : {}),
      })),
      [
        {
          id: 'audit-1',
          phase: 'started',
          operationId: 'background-1',
          turnTreeId: 'tree-current',
          budgetUsed: 1,
        },
        {
          id: 'audit-2',
          phase: 'finished',
          operationId: 'background-1',
          turnTreeId: 'tree-current',
          budgetUsed: 1,
          result: 'completed',
          turnOutcome,
        },
        {
          id: 'audit-3',
          phase: 'finished',
          operationId: 'background-1',
          turnTreeId: 'tree-current',
          result: 'duplicate',
        },
        {
          id: 'audit-4',
          phase: 'finished',
          operationId: 'background-stale',
          turnTreeId: 'tree-old',
          budgetUsed: 1,
          result: 'stale',
        },
      ],
    )
    assert.equal(JSON.stringify(audit).includes('private wake prompt'), false)
  })

  it('restores a durable epoch before dispatching a post-restart machine wake', async () => {
    let runCount = 0
    const savedEpochs: Array<{ turnTreeId: string; continuationUsed: number }> = []
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        loadEpoch: async () => ({ turnTreeId: 'tree-1', continuationUsed: 1 }),
        saveEpoch: async (_projectId, _threadId, epoch) => {
          savedEpochs.push(epoch)
        },
        run: async (_threadId, userContent, priorMessages) => {
          runCount++
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [...priorMessages, { role: 'user', content: userContent }],
          }
        },
      }),
    )

    assert.equal(
      await dispatcher.dispatchMachine({
        ...request(),
        operationId: 'restart-wake',
        turnTreeId: 'tree-1',
        payload: { userContent: 'wake', invokedSkills: [], priorTodos: [] },
      }),
      'completed',
    )
    assert.equal(runCount, 1)
    assert.deepEqual(savedEpochs, [{ turnTreeId: 'tree-1', continuationUsed: 2 }])
  })

  it('serializes completion wakes that arrive behind the same active turn', async () => {
    let release!: () => void
    let firstWakeEntered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      firstWakeEntered = resolve
    })
    const prompts: UserContent[] = []
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        run: async (_threadId, userContent, priorMessages) => {
          prompts.push(userContent)
          if (userContent === 'wake-1') {
            firstWakeEntered()
            await gate
          }
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [...priorMessages, { role: 'user', content: userContent }],
          }
        },
      }),
    )
    await dispatcher.dispatch(
      request({
        payload: {
          userContent: 'root',
          invokedSkills: [],
          priorTodos: [],
          turnTreeId: 'tree-1',
        },
      }),
    )
    const first = dispatcher.dispatchMachine({
      ...request(),
      operationId: 'background-1',
      turnTreeId: 'tree-1',
      payload: { userContent: 'wake-1', invokedSkills: [], priorTodos: [] },
    })
    await started
    const second = dispatcher.dispatchMachine({
      ...request(),
      operationId: 'background-2',
      turnTreeId: 'tree-1',
      payload: { userContent: 'wake-2', invokedSkills: [], priorTodos: [] },
    })

    release()

    assert.deepEqual(await Promise.all([first, second]), ['completed', 'completed'])
    assert.deepEqual(prompts, ['root', 'wake-1', 'wake-2'])
  })

  it('holds machine dispatch after the continuation budget is exhausted', async () => {
    let runCount = 0
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        run: async (_threadId, userContent, priorMessages) => {
          runCount += 1
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [...priorMessages, { role: 'user', content: userContent }],
          }
        },
      }),
    )
    await dispatcher.dispatch(
      request({
        payload: {
          userContent: 'root',
          invokedSkills: [],
          priorTodos: [],
          turnTreeId: 'tree-1',
          continuationBudgetUsed: 5,
        },
      }),
    )

    assert.equal(
      await dispatcher.dispatchMachine({
        ...request(),
        operationId: 'background-1',
        turnTreeId: 'tree-1',
        payload: { userContent: 'wake', invokedSkills: [], priorTodos: [] },
      }),
      'budget-exhausted',
    )
    assert.equal(runCount, 1)
  })

  it('records an already-observed wake without running a turn or spending budget', async () => {
    const prompts: UserContent[] = []
    const audit: { result?: string; budgetUsed?: number }[] = []
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        appendMachineContinuation: async (_projectId, _threadId, line) => {
          if (line.phase === 'finished') {
            audit.push({
              result: line.result,
              ...(line.budgetUsed !== undefined ? { budgetUsed: line.budgetUsed } : {}),
            })
          }
        },
        run: async (_threadId, userContent, priorMessages) => {
          prompts.push(userContent)
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [...priorMessages, { role: 'user', content: userContent }],
          }
        },
      }),
    )
    await dispatcher.dispatch(
      request({
        payload: {
          userContent: 'root',
          invokedSkills: [],
          priorTodos: [],
          turnTreeId: 'tree-1',
          continuationBudgetUsed: 0,
        },
      }),
    )

    const wake = (operationId: string, observed: boolean): Promise<MachineDispatchResult> =>
      dispatcher.dispatchMachine({
        ...request(),
        operationId,
        turnTreeId: 'tree-1',
        alreadyObserved: () => observed,
        payload: { userContent: operationId, invokedSkills: [], priorTodos: [] },
      })

    assert.equal(await wake('seen', true), 'observed')
    assert.equal(await wake('unseen', false), 'completed')
    assert.deepEqual(prompts, ['root', 'unseen'])
    assert.deepEqual(audit, [
      { result: 'observed', budgetUsed: 0 },
      { result: 'completed', budgetUsed: 1 },
    ])
  })

  it('charges an agent-started turn to the continuation budget and holds it once exhausted', async () => {
    const saved: Array<{ turnTreeId: string; continuationUsed: number }> = []
    const lines: Array<{ phase: string; result?: string; budgetUsed?: number }> = []
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        loadEpoch: async () => ({ turnTreeId: 'tree-1', continuationUsed: 4 }),
        saveEpoch: async (_projectId, _threadId, epoch) => {
          saved.push(epoch)
        },
        appendMachineContinuation: async (_projectId, _threadId, line) => {
          lines.push({
            phase: line.phase,
            ...(line.phase === 'finished' ? { result: line.result } : {}),
            ...(line.budgetUsed !== undefined ? { budgetUsed: line.budgetUsed } : {}),
          })
        },
      }),
    )

    const first = await dispatcher.claimAgentInitiatedTurn('project-1', 'thread-1', {
      override: false,
    })
    assert.equal(first.status, 'granted')
    await first.release()
    assert.deepEqual(saved, [{ turnTreeId: 'tree-1', continuationUsed: 5 }])

    const second = await dispatcher.claimAgentInitiatedTurn('project-1', 'thread-1', {
      override: false,
    })
    assert.equal(second.status, 'budget-exhausted')
    assert.equal(saved.length, 1, 'a held turn spends nothing')

    const allowed = await dispatcher.claimAgentInitiatedTurn('project-1', 'thread-1', {
      override: true,
    })
    assert.equal(allowed.status, 'granted')
    assert.deepEqual(saved.at(-1), { turnTreeId: 'tree-1', continuationUsed: 6 })
    assert.deepEqual(lines, [
      { phase: 'started', budgetUsed: 5 },
      { phase: 'finished', result: 'completed', budgetUsed: 5 },
      { phase: 'finished', result: 'budget-exhausted', budgetUsed: 5 },
      { phase: 'started', budgetUsed: 6 },
    ])
  })

  it('does not take the dispatch slot for an agent-started turn', async () => {
    const dispatcher = new AgentDispatcher(host, registry, dependencies())
    const claim = await dispatcher.claimAgentInitiatedTurn('project-1', 'thread-1', {
      override: false,
    })
    assert.equal(claim.status, 'granted')
    assert.equal(dispatcher.isActive('project-1', 'thread-1'), false)
    await dispatcher.dispatch(request())
  })

  it('refreshes an empty estimate-time history from the transcript before dispatch', async () => {
    const earlier: LLMMessage[] = [{ role: 'user', content: 'Earlier unanswered prompt' }]
    let promptPersisted = false
    let seen: LLMMessage[] = []
    const emitted: StreamChunk[] = []
    const dispatcher = new AgentDispatcher(
      { emit: (_threadId, chunk): void => void emitted.push(chunk) },
      registry,
      dependencies({
        loadHistory: async () => [],
        recoverHistory: async () => (promptPersisted ? earlier : []),
        transcriptLength: async () => 2,
        run: async (_threadId, _input, messages) => {
          seen = messages
          return { usage: { inputTokens: 0, outputTokens: 0 }, messages }
        },
      }),
    )
    assert.deepEqual(await dispatcher.history('project-1', 'thread-1'), [])
    promptPersisted = true
    await dispatcher.dispatch(request())
    assert.deepEqual(seen, earlier)
    assert.equal(
      emitted.some((chunk) => chunk.type === 'text'),
      false,
      'no false context-loss notice',
    )
  })

  it('routes pre-turn notices through the same transcript sink as agent output', async () => {
    const direct: StreamChunk[] = []
    const owned: StreamChunk[] = []
    let ended = false
    const dispatcher = new AgentDispatcher(
      { emit: (_threadId, chunk): void => void direct.push(chunk) },
      registry,
      dependencies({
        loadHistory: async () => [],
        transcriptLength: async () => 4,
        run: async (threadId, _input, messages, turnHost) => {
          turnHost.emit(threadId, { type: 'text', text: 'The answer.' })
          turnHost.emit(threadId, { type: 'done' })
          return { usage: { inputTokens: 0, outputTokens: 0 }, messages }
        },
      }),
      {
        begin: (): ReturnType<TurnTranscriptSink['begin']> => ({
          emit: (chunk): void => void owned.push(chunk),
          end: (): void => {
            ended = true
          },
        }),
      },
    )
    await dispatcher.dispatch(request())
    assert.deepEqual(direct, [], 'no output bypasses runtime transcript ownership')
    const notice = owned[0]
    assert.ok(notice)
    assert.equal(notice.type, 'text')
    assert.match(notice.text, /Earlier context is missing/)
    assert.deepEqual(owned.slice(1), [{ type: 'text', text: 'The answer.' }, { type: 'done' }])
    assert.equal(ended, true)
  })

  it('opens no window transcript for a machine wake that never starts a turn', async () => {
    const begun: string[] = []
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        run: async (threadId, _input, messages, turnHost) => {
          turnHost.emit(threadId, { type: 'done' })
          return { usage: { inputTokens: 0, outputTokens: 0 }, messages }
        },
      }),
      {
        begin: (_projectId, threadId): ReturnType<TurnTranscriptSink['begin']> => {
          begun.push(threadId)
          return { emit: (): void => {}, end: (): void => {} }
        },
      },
    )
    const wake = {
      ...request(),
      operationId: 'background-stale',
      turnTreeId: 'tree-not-on-disk',
      payload: { userContent: 'wake', invokedSkills: [], priorTodos: [] },
    }
    assert.equal(await dispatcher.dispatchMachine(wake), 'stale')
    assert.deepEqual(begun, [], 'a stale wake must not mark the thread running')

    assert.equal(
      await dispatcher.dispatchMachine({
        ...wake,
        operationId: 'background-live',
        turnTreeId: 'thread-1',
      }),
      'completed',
    )
    assert.deepEqual(begun, ['thread-1'])
  })

  it('warns when a turn starts with an empty history but a full transcript', async () => {
    const emitted: StreamChunk[] = []
    const dispatcher = new AgentDispatcher(
      { emit: (_threadId, chunk): void => void emitted.push(chunk) },
      registry,
      dependencies({ loadHistory: async () => [], transcriptLength: async () => 4 }),
    )

    await dispatcher.dispatch(request())

    const notice = emitted.find((chunk) => chunk.type === 'text')
    assert.ok(notice, 'expected a notice before the turn')
    assert.match(notice.text, /Earlier context is missing/)
    assert.match(notice.text, /4 messages/)
  })

  it('stays quiet on a fresh thread whose only message is the prompt', async () => {
    const emitted: StreamChunk[] = []
    const dispatcher = new AgentDispatcher(
      { emit: (_threadId, chunk): void => void emitted.push(chunk) },
      registry,
      dependencies({ loadHistory: async () => [], transcriptLength: async () => 1 }),
    )

    await dispatcher.dispatch(request())

    assert.equal(
      emitted.filter((chunk) => chunk.type === 'text').length,
      0,
      'a first turn has lost nothing',
    )
  })

  it('stays quiet when the model already has history', async () => {
    const emitted: StreamChunk[] = []
    let transcriptReads = 0
    const dispatcher = new AgentDispatcher(
      { emit: (_threadId, chunk): void => void emitted.push(chunk) },
      registry,
      dependencies({
        loadHistory: async () => [{ role: 'assistant', content: 'prior' }],
        transcriptLength: async () => {
          transcriptReads += 1
          return 9
        },
      }),
    )

    await dispatcher.dispatch(request())

    assert.equal(emitted.filter((chunk) => chunk.type === 'text').length, 0)
    // The common path must not pay for a thread read it cannot learn from.
    assert.equal(transcriptReads, 0)
  })

  it('stays quiet when the transcript rebuild recovered the history', async () => {
    const emitted: StreamChunk[] = []
    const dispatcher = new AgentDispatcher(
      { emit: (_threadId, chunk): void => void emitted.push(chunk) },
      registry,
      dependencies({
        loadHistory: async () => [],
        // Recovery runs first and succeeds, so nothing was lost by the time the
        // notice would fire — even though the sidecar itself was empty.
        recoverHistory: async () => [{ role: 'user', content: 'the question a dead turn lost' }],
        transcriptLength: async () => 6,
      }),
    )

    await dispatcher.dispatch(request())

    assert.equal(
      emitted.filter((chunk) => chunk.type === 'text').length,
      0,
      'a recovered history is not a lost one',
    )
  })

  it('runs the turn anyway when the transcript cannot be read', async () => {
    let ran = false
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        loadHistory: async () => [],
        transcriptLength: () => Promise.reject(new Error('store unavailable')),
        run: async (_threadId, userContent, priorMessages) => {
          ran = true
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [...priorMessages, { role: 'user', content: userContent }],
          }
        },
      }),
    )

    await dispatcher.dispatch(request())

    assert.equal(ran, true)
  })
})
