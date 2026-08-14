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
    let nextId = 0
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        appendMachineContinuation: async (_projectId, _threadId, line) => {
          audit.push(line)
        },
        createId: () => `audit-${String(++nextId)}`,
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
      audit.map(({ phase, operationId, turnTreeId, budgetUsed, ...line }) => ({
        id: line.id,
        phase,
        operationId,
        turnTreeId,
        ...(budgetUsed !== undefined ? { budgetUsed } : {}),
        ...('result' in line ? { result: line.result } : {}),
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
