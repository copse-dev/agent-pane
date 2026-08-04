import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LLMMessage, StreamChunk, UserContent } from '@shared/types'
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
    prepareExecutionContext: async () => context,
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
})
