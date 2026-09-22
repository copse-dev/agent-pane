import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LLMMessage, StreamChunk, UserContent } from '@shared/types'
import type { SpineMachineContinuationLine } from '@shared/threads/spine-schema.ts'
import type { AgentHost } from '@copse/agent/agent-host.ts'
import { ToolRegistry } from './tool-registry.ts'
import {
  AgentDispatcher,
  type AgentDispatcherDependencies,
  type AgentDispatchRequest,
} from './agent-dispatcher.ts'
import type { ThreadExecutionContext } from './thread-execution-context.ts'

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
    prepareExecutionContext: async () => context,
    transcriptLength: async () => 0,
    run: async (_threadId, userContent, priorMessages) => ({
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: [...priorMessages, { role: 'user', content: userContent }],
    }),
    ...overrides,
  }
}

describe('AgentDispatcher', () => {
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
    await assert.rejects(dispatcher.dispatch(request()), /already running for thread "thread-1"/)
    release()
    await first
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
